// ============================================================
// KAIZER MODE 3 — FFmpeg Cutter Service
// Deploy on Railway. Accepts raw video upload + clip timestamps.
// Cuts highlights with frame-accurate FFmpeg, returns merged MP4.
// ============================================================
 
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const ffmpeg  = require('fluent-ffmpeg');
const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');
 
const app  = express();
const PORT = process.env.PORT || 3000;
 
// ── CORS: allow all origins (Mode 3 runs from file:// or any host) ──
app.use(cors());
app.use(express.json());
 
// ── Temp storage for uploads ──
const TMP = '/tmp/kaizer';
fs.mkdirSync(TMP, { recursive: true });
 
const storage = multer.diskStorage({
  destination: TMP,
  filename: (req, file, cb) => cb(null, `input_${Date.now()}.mp4`)
});
const upload = multer({
  storage,
  limits: { fileSize: 600 * 1024 * 1024 } // 600MB
});
 
// ── Health check ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'kaizer-cutter', version: '1.0' });
});
 
// ── MAIN ENDPOINT: POST /cut ──
// Body: multipart/form-data
//   file: video file
//   clips: JSON string [{start_sec, end_sec, label}]
//   preroll: seconds to add before each clip start (default 1.5)
//
// Returns: { downloadUrl, clips: [{index, start, end, duration}] }
 
app.post('/cut', upload.single('file'), async (req, res) => {
  const startTime = Date.now();
 
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
 
  let clips;
  try {
    clips = JSON.parse(req.body.clips || '[]');
  } catch(e) {
    return res.status(400).json({ error: 'Invalid clips JSON: ' + e.message });
  }
 
  if (!clips.length) {
    return res.status(400).json({ error: 'No clips provided' });
  }
 
  const preroll  = parseFloat(req.body.preroll || '4.0');
  const tail     = parseFloat(req.body.tail || '1.5');
  const ratio    = req.body.ratio || '16:9';        // '16:9' | '9:16'
  const captions = req.body.captions === '1';
  let captionData = [];
  if (captions && req.body.captionData) {
    try { captionData = JSON.parse(req.body.captionData); } catch(e) {}
  }
 
  const is916 = ratio === '9:16';
  const outW = is916 ? 540 : 960;
  const outH = is916 ? 960 : 540;
 
  console.log(`[${jobId}] ${clips.length} clips | ratio:${ratio} | captions:${captions} | preroll:${preroll}s | tail:${tail}s`);
  const jobId     = Date.now();
  const segFiles  = [];
  const results   = [];
 
  console.log(`[${jobId}] Cutting ${clips.length} clips from ${req.file.originalname} (${(req.file.size/1024/1024).toFixed(1)}MB), preroll=${preroll}s`);
 
  try {
    // Get video duration
    const duration = await getVideoDuration(inputFile);
    console.log(`[${jobId}] Video duration: ${duration.toFixed(1)}s`);
 
    // Cut each clip
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const start = Math.max(0, clip.start_sec - preroll);
      const end   = Math.min(duration, clip.end_sec + tail);
      const dur   = end - start;
 
      const segPath = path.join(TMP, `seg_${jobId}_${i}.mp4`);
      console.log(`[${jobId}] Clip ${i+1}/${clips.length}: ${start.toFixed(2)}s → ${end.toFixed(2)}s (${dur.toFixed(1)}s)`);
 
      // Build FFmpeg filter chain
      let vfFilters = [];
 
      // 9:16 crop: scale to fill height, crop to portrait
      if (is916) {
        vfFilters.push(`scale=${outW * 2}:-1`);
        vfFilters.push(`crop=${outW}:${outH}`);
      } else {
        vfFilters.push(`scale=${outW}:${outH}`);
      }
 
      // Caption burn-in using drawtext
      if (captions && captionData[i] && captionData[i].text) {
        const text = captionData[i].text
          .replace(/'/g, "\u2019")  // replace single quotes for ffmpeg
          .replace(/:/g, '\\:')
          .replace(/\[/g, '\\[').replace(/\]/g, '\\]');
        const fontSize = is916 ? 36 : 24;
        const yPos = is916 ? `h-160` : `h-80`;
        vfFilters.push(
          `drawbox=y=${yPos}:color=black@0.75:width=iw:height=${is916?140:70}:t=fill`,
          `drawtext=fontfile=/usr/share/fonts/truetype/noto/NotoSansTelugu-Regular.ttf:` +
          `text='${text}':fontsize=${fontSize}:fontcolor=white:` +
          `x=(w-text_w)/2:y=${yPos}+20:line_spacing=8`
        );
      }
 
      const vfArg = vfFilters.join(',');
 
      await cutClip(inputFile, segPath, start, dur, vfArg);
      segFiles.push(segPath);
      results.push({ index: i, start, end, duration: dur });
    }
 
    // Merge all clips
    const outputPath = path.join(TMP, `merged_${jobId}.mp4`);
 
    if (segFiles.length === 1) {
      fs.copyFileSync(segFiles[0], outputPath);
    } else {
      await mergeClips(segFiles, outputPath);
    }
 
    const outputSize = fs.statSync(outputPath).size;
    const elapsed    = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${jobId}] Done in ${elapsed}s — ${(outputSize/1024/1024).toFixed(1)}MB`);
 
    // Serve via download endpoint
    const token = `${jobId}`;
 
    // Schedule cleanup after 10 min
    setTimeout(() => {
      try { fs.unlinkSync(outputPath); } catch(e) {}
      segFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
      try { fs.unlinkSync(inputFile); } catch(e) {}
      console.log(`[${token}] Cleaned up temp files`);
    }, 10 * 60 * 1000);
 
    res.json({
      success: true,
      downloadUrl: `/download/${token}`,
      sizeMB: (outputSize / 1024 / 1024).toFixed(1),
      elapsedSec: elapsed,
      clips: results,
      _outputPath: outputPath // stored server-side for /download endpoint
    });
 
    // Store path for download (simple in-memory map)
    pendingDownloads.set(token, outputPath);
 
  } catch(err) {
    console.error(`[${jobId}] Error:`, err.message);
    // Cleanup
    segFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
    try { fs.unlinkSync(inputFile); } catch(e) {}
    res.status(500).json({ error: err.message });
  }
});
 
// ── DOWNLOAD ENDPOINT ──
const pendingDownloads = new Map();
 
app.get('/download/:token', (req, res) => {
  const outputPath = pendingDownloads.get(req.params.token);
  if (!outputPath || !fs.existsSync(outputPath)) {
    return res.status(404).json({ error: 'File not found or expired' });
  }
  const filename = `kaizer_highlights_${req.params.token}.mp4`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'video/mp4');
  res.sendFile(outputPath);
});
 
// ── HELPERS ──
 
function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration || 0);
    });
  });
}
 
function cutClip(input, output, startSec, durationSec, vfArg) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(input)
      .setStartTime(startSec)
      .setDuration(durationSec);
 
    if (vfArg) {
      cmd.videoFilter(vfArg);
      cmd.outputOptions(['-c:v libx264', '-c:a aac', '-preset ultrafast', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart']);
    } else {
      cmd.outputOptions(['-c:v libx264', '-c:a aac', '-preset ultrafast', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart']);
    }
 
    cmd.output(output)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}
 
function mergeClips(segFiles, output) {
  return new Promise((resolve, reject) => {
    // Write concat list
    const concatFile = output + '.txt';
    const lines = segFiles.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(concatFile, lines);
 
    ffmpeg()
      .input(concatFile)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions([
        '-c', 'copy',
        '-movflags', '+faststart'
      ])
      .output(output)
      .on('end', () => {
        try { fs.unlinkSync(concatFile); } catch(e) {}
        resolve();
      })
      .on('error', (err) => {
        try { fs.unlinkSync(concatFile); } catch(e) {}
        reject(err);
      })
      .run();
  });
}
 
app.listen(PORT, () => {
  console.log(`Kaizer Cutter running on port ${PORT}`);
  // Check FFmpeg available
  try {
    const v = execSync('ffmpeg -version 2>&1').toString().split('\n')[0];
    console.log('FFmpeg:', v);
  } catch(e) {
    console.warn('FFmpeg not found in PATH — install it in Dockerfile');
  }
});
