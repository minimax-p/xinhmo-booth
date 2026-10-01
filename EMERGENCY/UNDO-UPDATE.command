#!/bin/bash
# ============================================================
#  TAKE THE LAST UPDATE BACK OUT
#  If the booth works worse after UPDATE, double-click this.
#  It needs no internet.
# ============================================================
bash "$(dirname "$0")/../app/scripts/update.sh" undo
