#!/usr/bin/env bash
# ============================================================================
# Project Polished — Demo Video Polisher
# Converts the raw agent-browser webm recording into a polished MP4 with
# title/footer overlays + trims dead air.
#
# Input:  download/project-polished-demo.webm
# Output: download/project-polished-demo.mp4
# ============================================================================

set -euo pipefail

cd /home/z/my-project

INPUT="download/project-polished-demo.webm"
OUTPUT="download/project-polished-demo.mp4"
TRIMMED="download/_trimmed.webm"

# --- Step 1: Trim 1.5s of dead air from start and 0.5s from end ----------
echo "→ Trimming dead air..."
ffmpeg -y -ss 1.5 -i "$INPUT" -t 28 -c:v libvpx -an "$TRIMMED" 2>&1 | tail -2

# --- Step 2: Convert + add title/footer overlays --------------------------
echo "→ Rendering polished MP4 with overlays..."

# Fonts available
FONT_REG="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

ffmpeg -y -i "$TRIMMED" \
  -vf "
    drawtext=
      fontfile='$FONT_REG':
      text='Project Polished — Autonomous UI/UX Agent':
      fontcolor=white:
      fontsize=32:
      box=1:
      boxcolor=0x00000000:
      boxborderw=0:
      x=(w-text_w)/2:
      y=24:
      alpha='if(lt(t,1),t,1)',
    drawtext=
      fontfile='$FONT_REG':
      text='Solari SDK Bounty Demo · @harrychow_ @getsolari @im_roy_lee':
      fontcolor=0x10b981:
      fontsize=20:
      box=1:
      boxcolor=0x00000000:
      x=(w-text_w)/2:
      y=h-44:
      alpha='if(lt(t,1),t,1)'
  " \
  -c:v libx264 \
  -preset medium \
  -crf 22 \
  -pix_fmt yuv420p \
  -movflags +faststart \
  "$OUTPUT" 2>&1 | tail -5

# --- Step 3: Cleanup intermediate ----------------------------------------
rm -f "$TRIMMED"

# --- Step 4: Stats -------------------------------------------------------
echo ""
echo "→ Final video:"
ls -lh "$OUTPUT"
ffprobe -v error -show_entries format=duration,size -show_entries stream=width,height,codec_name -of default=noprint_wrappers=1 "$OUTPUT"
