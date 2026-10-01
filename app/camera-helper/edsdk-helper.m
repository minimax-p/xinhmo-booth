/*
 * xinhmo-camera: holds one Canon camera through the EDSDK for as long as the
 * booth runs, and does what the booth asks over stdin/stdout.
 *
 * Why a separate program. The EDSDK only works on macOS from inside a real app
 * with a running event loop -- Canon's manual says console programs are not
 * guaranteed to work, and in testing a bare one could list the camera but
 * never open it. Electron cannot give it that, so this is the app: no window,
 * no Dock icon, launched and supervised by camera-edsdk.js.
 *
 * Why one connection. The gphoto2 driver started a new process for every shot
 * and another for live view, so the camera was released and re-claimed around
 * each photo: an 8-second gap in the preview, a race with macOS for the device,
 * and a wedged camera whenever a process was interrupted. Here the session
 * stays open all night. Live view, focus and capture all go through it.
 *
 * Protocol
 *   stdin   one JSON object per line: {"id":1,"cmd":"status"}
 *           cmd = status | live {on} | focus | capture {path} | quit
 *   stdout  one JSON object per line: replies {"id":1,"ok":true,...} and
 *           events {"event":"connected","model":"..."}
 *   fd 3    live-view frames: 4-byte big-endian length, then the JPEG.
 *           Kept off stdout so a frame can never be mistaken for a message.
 *
 * Threads. Every EDSDK call except discovery happens on one worker thread,
 * as in Canon's sample (Processor.m). The main thread only runs the event
 * loop, which is where the SDK delivers its callbacks; they set flags that
 * the worker acts on.
 */
#import <Cocoa/Cocoa.h>
#include <stdatomic.h>
#include <signal.h>
#include <unistd.h>
#include "EDSDK.h"

// ------------------------------------------------------------------ output

static NSLock *outLock;

static void emit(NSDictionary *msg) {
  NSData *d = [NSJSONSerialization dataWithJSONObject:msg options:0 error:nil];
  if (!d) return;
  [outLock lock];
  fwrite(d.bytes, 1, d.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
  [outLock unlock];
}

static void logLine(NSString *fmt, ...) NS_FORMAT_FUNCTION(1, 2);
static void logLine(NSString *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  NSString *s = [[NSString alloc] initWithFormat:fmt arguments:ap];
  va_end(ap);
  emit(@{ @"event" : @"log", @"message" : s });
}

static NSString *hex(EdsError e) { return [NSString stringWithFormat:@"0x%08X", (unsigned)e]; }

static BOOL framesOpen = YES;

static void writeFrame(const void *bytes, EdsUInt64 len) {
  if (!framesOpen || len == 0 || len > 0x7FFFFFFF) return;
  uint32_t n = htonl((uint32_t)len);
  if (write(3, &n, 4) != 4 || write(3, bytes, (size_t)len) != (ssize_t)len) framesOpen = NO;
}

// ------------------------------------------------------------------ state

// Owned by the worker thread.
static EdsCameraRef cam = NULL;
static BOOL sessionOpen = NO;
static BOOL liveOn = NO;
static NSString *model = @"";
static NSDate *focusStarted = nil;
static NSDate *lastKeepAwake = nil;

// Wanted state, set from any thread.
static _Atomic(BOOL) wantLive = NO;
static _Atomic(BOOL) quitting = NO;

// Set by SDK callbacks on the main thread, consumed by the worker.
static _Atomic(EdsDirectoryItemRef) pendingItem = NULL;
static _Atomic(BOOL) cameraGone = NO;
static _Atomic(BOOL) sleepSoon = NO;
static _Atomic(EdsUInt32) captureError = 0;

static NSMutableArray *queue;
static NSLock *queueLock;

static void nap(double s) { [NSThread sleepForTimeInterval:s]; }
static double since(NSDate *t) { return t ? -[t timeIntervalSinceNow] : 1e9; }

// ------------------------------------------------------------------ callbacks

static EdsError EDSCALLBACK onObject(EdsObjectEvent ev, EdsBaseRef ref, EdsVoid *ctx) {
  if (ev == kEdsObjectEvent_DirItemRequestTransfer) {
    EdsDirectoryItemRef old = atomic_exchange(&pendingItem, (EdsDirectoryItemRef)ref);
    if (old) EdsRelease(old);
    return EDS_ERR_OK;
  }
  if (ref) EdsRelease(ref);
  return EDS_ERR_OK;
}

static EdsError EDSCALLBACK onState(EdsStateEvent ev, EdsUInt32 param, EdsVoid *ctx) {
  switch (ev) {
    case kEdsStateEvent_Shutdown: atomic_store(&cameraGone, YES); break;
    case kEdsStateEvent_WillSoonShutDown: atomic_store(&sleepSoon, YES); break;
    case kEdsStateEvent_CaptureError: atomic_store(&captureError, param ? param : 1); break;
    default: break;
  }
  return EDS_ERR_OK;
}

// ------------------------------------------------------------------ session

static BOOL isDisconnect(EdsError e) {
  return e == EDS_ERR_COMM_DISCONNECTED || e == EDS_ERR_DEVICE_NOT_FOUND ||
         e == EDS_ERR_SESSION_NOT_OPEN || e == EDS_ERR_INVALID_HANDLE;
}

static void setLive(BOOL on) {
  if (!sessionOpen) { liveOn = NO; return; }
  EdsUInt32 dev = 0;
  EdsGetPropertyData(cam, kEdsPropID_Evf_OutputDevice, 0, sizeof dev, &dev);
  dev = on ? (dev | kEdsEvfOutputDevice_PC) : (dev & ~kEdsEvfOutputDevice_PC);
  EdsError e = EdsSetPropertyData(cam, kEdsPropID_Evf_OutputDevice, 0, sizeof dev, &dev);
  if (e == EDS_ERR_OK) liveOn = on;
  else logLine(@"live view %@ failed: %@", on ? @"on" : @"off", hex(e));
}

static void dropSession(NSString *why) {
  if (cam) {
    if (sessionOpen) {
      if (liveOn) setLive(NO);
      EdsCloseSession(cam);
    }
    EdsRelease(cam);
  }
  cam = NULL;
  sessionOpen = NO;
  liveOn = NO;
  focusStarted = nil;
  EdsDirectoryItemRef item = atomic_exchange(&pendingItem, NULL);
  if (item) EdsRelease(item);
  if (why) emit(@{ @"event" : @"disconnected", @"reason" : why });
}

/** Find the camera and open a session. Discovery runs on the main thread,
 *  where the SDK's device notifications arrive. */
static BOOL connectCamera(void) {
  __block EdsCameraRef found = NULL;
  dispatch_sync(dispatch_get_main_queue(), ^{
    EdsCameraListRef list = NULL;
    EdsUInt32 n = 0;
    if (EdsGetCameraList(&list) == EDS_ERR_OK) {
      EdsGetChildCount(list, &n);
      if (n > 0) EdsGetChildAtIndex(list, 0, &found);
    }
    if (list) EdsRelease(list);
  });
  if (!found) return NO;

  EdsError e = EDS_ERR_DEVICE_BUSY;
  for (int t = 0; t < 4 && e != EDS_ERR_OK; t++) {
    e = EdsOpenSession(found);
    if (e != EDS_ERR_OK) nap(0.5);  // Canon: leave ~500ms before reissuing
  }
  if (e != EDS_ERR_OK) {
    logLine(@"camera found but the session would not open: %@", hex(e));
    EdsRelease(found);
    return NO;
  }
  cam = found;
  sessionOpen = YES;

  // Photos come straight to the Mac. Nothing is written to the card, so a
  // full or missing card cannot stop the booth.
  EdsUInt32 to = kEdsSaveTo_Host;
  EdsSetPropertyData(cam, kEdsPropID_SaveTo, 0, sizeof to, &to);
  EdsCapacity cap = {0x7FFFFFFF, 0x1000, 1};
  EdsSetCapacity(cam, cap);
  EdsSetObjectEventHandler(cam, kEdsObjectEvent_All, onObject, NULL);
  EdsSetCameraStateEventHandler(cam, kEdsStateEvent_All, onState, NULL);
  atomic_store(&cameraGone, NO);

  char name[EDS_MAX_NAME] = {0};
  EdsGetPropertyData(cam, kEdsPropID_ProductName, 0, sizeof name, name);
  model = [NSString stringWithUTF8String:name] ?: @"Canon camera";
  lastKeepAwake = [NSDate date];
  emit(@{ @"event" : @"connected", @"model" : model });
  return YES;
}

// ------------------------------------------------------------------ capture

static NSString *captureMessage(EdsError e) {
  switch (e) {
    case EDS_ERR_TAKE_PICTURE_AF_NG: return @"The camera could not focus.";
    case EDS_ERR_TAKE_PICTURE_NO_LENS_NG: return @"No lens on the camera.";
    case EDS_ERR_TAKE_PICTURE_MIRROR_UP_NG: return @"The camera's mirror is locked up.";
    case EDS_ERR_DEVICE_BUSY: return @"The camera is busy. Try again.";
    default: return [NSString stringWithFormat:@"The camera would not take the photo (%@).", hex(e)];
  }
}

/** Press the shutter all the way and let go, as a finger would. */
static EdsError press(BOOL withAF) {
  EdsError e = EdsSendCommand(cam, kEdsCameraCommand_PressShutterButton,
                              withAF ? kEdsCameraCommand_ShutterButton_Completely
                                     : kEdsCameraCommand_ShutterButton_Completely_NonAF);
  EdsSendCommand(cam, kEdsCameraCommand_PressShutterButton, kEdsCameraCommand_ShutterButton_OFF);
  return e;
}

static NSDictionary *capture(NSString *path) {
  if (!sessionOpen) return @{ @"ok" : @NO, @"error" : @"The camera is not connected." };

  // Live-view focus on this body takes ~3s to lock and ~4s to settle. If it
  // was started early enough -- at the start of the countdown -- fire without
  // refocusing, which takes under a second. Otherwise the camera focuses as
  // it fires.
  BOOL focused = liveOn && since(focusStarted) >= 3.5 && since(focusStarted) < 60;
  if (liveOn) EdsSendCommand(cam, kEdsCameraCommand_DoEvfAf, kEdsCameraCommand_EvfAf_OFF);
  focusStarted = nil;

  EdsDirectoryItemRef stale = atomic_exchange(&pendingItem, NULL);
  if (stale) EdsRelease(stale);
  atomic_store(&captureError, 0);

  NSDate *fired = [NSDate date];
  BOOL withAF = !focused;
  EdsError e = press(withAF);
  BOOL retried = NO;
  EdsDirectoryItemRef item = NULL;
  for (;;) {
    item = atomic_exchange(&pendingItem, NULL);
    if (item) break;
    EdsUInt32 ce = atomic_exchange(&captureError, 0);
    BOOL failed = (e != EDS_ERR_OK) || ce;
    if (failed && withAF && !retried) {
      // At an event a slightly soft photo beats no photo at all.
      logLine(@"focus failed (%@), firing without it", hex(e ? e : ce));
      retried = YES;
      withAF = NO;
      nap(0.5);
      e = press(NO);
      fired = [NSDate date];
      continue;
    }
    if (failed) return @{ @"ok" : @NO, @"error" : captureMessage(e ? e : ce) };
    if (atomic_load(&cameraGone)) return @{ @"ok" : @NO, @"error" : @"The camera disconnected." };
    if (since(fired) > 15) return @{ @"ok" : @NO, @"error" : @"The camera took the photo but never sent it." };
    nap(0.01);
  }
  double firedToReady = since(fired);

  // Download to a temporary name and rename, so the booth never sees half a file.
  EdsDirectoryItemInfo info;
  EdsGetDirectoryItemInfo(item, &info);
  NSString *tmp = [path stringByAppendingString:@".part"];
  EdsStreamRef file = NULL;
  e = EdsCreateFileStream(tmp.fileSystemRepresentation, kEdsFileCreateDisposition_CreateAlways,
                          kEdsAccess_ReadWrite, &file);
  if (e == EDS_ERR_OK) e = EdsDownload(item, info.size, file);
  if (e == EDS_ERR_OK) e = EdsDownloadComplete(item);
  else EdsDownloadCancel(item);
  if (file) EdsRelease(file);
  EdsRelease(item);
  if (e != EDS_ERR_OK || rename(tmp.fileSystemRepresentation, path.fileSystemRepresentation) != 0) {
    unlink(tmp.fileSystemRepresentation);
    return @{ @"ok" : @NO, @"error" : [NSString stringWithFormat:@"The photo could not be saved (%@).", hex(e)] };
  }
  return @{
    @"ok" : @YES, @"path" : path, @"bytes" : @(info.size), @"focusedEarly" : @(focused),
    @"refocused" : @(retried), @"firedToReadyMs" : @((int)(firedToReady * 1000))
  };
}

// ------------------------------------------------------------------ commands

static NSDictionary *statusReply(void) {
  EdsUInt32 batt = 0;
  if (sessionOpen) EdsGetPropertyData(cam, kEdsPropID_BatteryLevel, 0, sizeof batt, &batt);
  return @{
    @"ok" : @YES, @"connected" : @(sessionOpen), @"model" : model, @"live" : @(liveOn),
    @"battery" : @(batt == 0xFFFFFFFF ? -1 : (int)batt)
  };
}

static void handle(NSDictionary *msg) {
  id rid = msg[@"id"] ?: [NSNull null];
  NSString *cmd = msg[@"cmd"];
  NSMutableDictionary *reply;
  if ([cmd isEqual:@"status"]) {
    reply = [statusReply() mutableCopy];
  } else if ([cmd isEqual:@"live"]) {
    atomic_store(&wantLive, [msg[@"on"] boolValue]);
    if (sessionOpen && liveOn != [msg[@"on"] boolValue]) setLive([msg[@"on"] boolValue]);
    reply = [@{ @"ok" : @YES, @"live" : @(liveOn) } mutableCopy];
  } else if ([cmd isEqual:@"focus"]) {
    if (!sessionOpen) {
      reply = [@{ @"ok" : @NO, @"error" : @"The camera is not connected." } mutableCopy];
    } else {
      if (!liveOn) setLive(YES);
      EdsError e = EdsSendCommand(cam, kEdsCameraCommand_DoEvfAf, kEdsCameraCommand_EvfAf_ON);
      if (e == EDS_ERR_OK) focusStarted = [NSDate date];
      reply = [@{ @"ok" : @(e == EDS_ERR_OK) } mutableCopy];
      if (e != EDS_ERR_OK) reply[@"error"] = captureMessage(e);
    }
  } else if ([cmd isEqual:@"capture"]) {
    NSString *path = msg[@"path"];
    reply = path.length ? [capture(path) mutableCopy]
                        : [@{ @"ok" : @NO, @"error" : @"No path given." } mutableCopy];
  } else if ([cmd isEqual:@"quit"]) {
    atomic_store(&quitting, YES);
    reply = [@{ @"ok" : @YES } mutableCopy];
  } else {
    reply = [@{ @"ok" : @NO, @"error" : [NSString stringWithFormat:@"Unknown command: %@", cmd] } mutableCopy];
  }
  reply[@"id"] = rid;
  emit(reply);
}

// ------------------------------------------------------------------ worker

static void worker(void) {
  NSDate *lastTry = nil;
  int missed = 0;
  while (!atomic_load(&quitting)) {
    @autoreleasepool {
      // Commands first, so a capture never waits behind a frame.
      NSDictionary *msg = nil;
      [queueLock lock];
      if (queue.count) { msg = queue.firstObject; [queue removeObjectAtIndex:0]; }
      [queueLock unlock];
      if (msg) { handle(msg); continue; }

      if (atomic_load(&cameraGone) && sessionOpen) {
        atomic_store(&cameraGone, NO);
        dropSession(@"The camera was switched off or unplugged.");
      }

      if (!sessionOpen) {
        if (since(lastTry) >= 2) {
          lastTry = [NSDate date];
          if (connectCamera() && atomic_load(&wantLive)) setLive(YES);
        }
        nap(0.05);
        continue;
      }

      // Keep it awake: act on the camera's own warning, and nudge it
      // regularly anyway -- a camera that powers down drops off USB.
      if (atomic_exchange(&sleepSoon, NO) || since(lastKeepAwake) > 60) {
        EdsSendCommand(cam, kEdsCameraCommand_ExtendShutDownTimer, 0);
        lastKeepAwake = [NSDate date];
      }

      if (atomic_load(&wantLive) != liveOn) setLive(atomic_load(&wantLive));

      if (liveOn) {
        EdsStreamRef s = NULL;
        EdsEvfImageRef img = NULL;
        EdsCreateMemoryStream(0, &s);
        EdsCreateEvfImageRef(s, &img);
        EdsError e = EdsDownloadEvfImage(cam, img);
        if (e == EDS_ERR_OK) {
          EdsUInt64 len = 0;
          EdsVoid *ptr = NULL;
          EdsGetLength(s, &len);
          EdsGetPointer(s, &ptr);
          writeFrame(ptr, len);
          missed = 0;
        } else if (isDisconnect(e) || ++missed > 150) {
          // OBJECT_NOTREADY for a second after each photo is normal; a
          // lasting failure is not.
          dropSession([NSString stringWithFormat:@"Live view stopped (%@).", hex(e)]);
          missed = 0;
        }
        if (img) EdsRelease(img);
        if (s) EdsRelease(s);
        nap(0.04);
      } else {
        nap(0.05);
      }
    }
  }
  dropSession(nil);
  dispatch_async(dispatch_get_main_queue(), ^{ [NSApp terminate:nil]; });
}

// ------------------------------------------------------------------ stdin

static void reader(void) {
  char *line = NULL;
  size_t cap = 0;
  ssize_t n;
  while ((n = getline(&line, &cap, stdin)) > 0) {
    NSData *d = [NSData dataWithBytes:line length:(NSUInteger)n];
    id msg = [NSJSONSerialization JSONObjectWithData:d options:0 error:nil];
    if (![msg isKindOfClass:[NSDictionary class]]) continue;
    [queueLock lock];
    [queue addObject:msg];
    [queueLock unlock];
  }
  // stdin closed: the booth has gone. Let go of the camera rather than
  // holding it for a booth that is not coming back.
  atomic_store(&quitting, YES);
}

// ------------------------------------------------------------------ app

@interface Helper : NSObject <NSApplicationDelegate>
@end

@implementation Helper
- (void)applicationDidFinishLaunching:(NSNotification *)n {
  EdsError e = EdsInitializeSDK();
  if (e != EDS_ERR_OK) {
    emit(@{ @"event" : @"fatal", @"error" : [NSString stringWithFormat:@"EDSDK would not start (%@).", hex(e)] });
    [NSApp terminate:nil];
    return;
  }
  // Device discovery is asynchronous; give it a moment on the event loop.
  [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.5]];
  emit(@{ @"event" : @"ready" });
  [NSThread detachNewThreadWithBlock:^{ worker(); }];
  [NSThread detachNewThreadWithBlock:^{ reader(); }];
}
- (void)applicationWillTerminate:(NSNotification *)n {
  EdsTerminateSDK();
}
@end

int main(int argc, const char **argv) {
  @autoreleasepool {
    signal(SIGPIPE, SIG_IGN);
    outLock = [NSLock new];
    queueLock = [NSLock new];
    queue = [NSMutableArray new];
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyProhibited];
    Helper *h = [Helper new];
    app.delegate = h;
    [app run];
  }
  return 0;
}
