// KAIZER MODE 3 — Cutter + Transcriber v2.1
// POST /transcribe — calls Python Sarvam SDK (full file, no chunking)
// POST /cut        — FFmpeg frame-accurate cuts + 9:16 + captions
// GET  /download/:token

const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const ffmpeg   = require('fluent-ffmpeg');
const fs       = require('fs');
const path     = require('path');
const { execSync, spawn } = require('child_process');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const TMP = '/tmp/kaizer';
fs.mkdirSync(TMP, { recursive: true });

const storage = multer.diskStorage({
  destination: TMP,
  filename: (req, file, cb) => cb(null, `upload_${Date.now()}`)
});
const upload = multer({ storage, limits: { fileSize: 600 * 1024 * 1024 } });
const pendingDownloads = new Map();

// Health / Frontend
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
  res.json({ status: 'ok', service: 'kaizer-cutter', version: '2.1' });
});
app.use(express.static(path.join(__dirname, 'public')));

// ================================================================
// POST /transcribe
// Uses Python sarvamai SDK — full file Batch API, no chunking
// ================================================================
app.post('/transcribe', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const sarvamKey = req.body.sarvamKey || req.headers['x-sarvam-key'];
  if (!sarvamKey) { try{fs.unlinkSync(req.file.path);}catch(e){} return res.status(400).json({ error: 'sarvamKey required' }); }

  const language  = req.body.language || 'te-IN';
  const jobId     = Date.now();
  const inputFile = req.file.path;
  console.log(`[${jobId}] TRANSCRIBE: ${(req.file.size/1024/1024).toFixed(1)}MB`);

  try {
    // Extract 16kHz mono WAV for Sarvam
    const audioPath = path.join(TMP, `audio_${jobId}.wav`);
    await extractAudio(inputFile, audioPath);
    console.log(`[${jobId}] Audio extracted, calling Python Sarvam SDK...`);

    // Call Python script with Sarvam SDK
    const result = await runPython([
      path.join(__dirname, 'transcribe.py'),
      audioPath,
      sarvamKey,
      language
    ]);

    [audioPath, inputFile].forEach(f => { try{fs.unlinkSync(f);}catch(e){} });

    console.log(`[${jobId}] Done: ${result.segments?.length||0} segments`);
    res.json({ success: true, segments: result.segments||[], transcript: result.transcript||'' });

  } catch(err) {
    try{fs.unlinkSync(inputFile);}catch(e){}
    console.error(`[${jobId}] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

function runPython(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', args, { timeout: 10 * 60 * 1000 });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => { stderr += d; console.log('[PY]', d.toString().trim()); });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || `Python exited ${code}`));
      try { resolve(JSON.parse(stdout)); }
      catch(e) { reject(new Error('Invalid JSON from Python: ' + stdout.slice(0,200))); }
    });
    proc.on('error', reject);
  });
}

// ================================================================
// POST /cut
// ================================================================
app.post('/cut', upload.single('file'), async (req, res) => {
  const startTime = Date.now();
  if (!req.file) return res.status(400).json({ error: 'No file' });
  let clips;
  try { clips = JSON.parse(req.body.clips||'[]'); } catch(e) { return res.status(400).json({error:'Bad clips JSON'}); }
  if (!clips.length) return res.status(400).json({ error: 'No clips' });

  const jobId    = Date.now();
  const inputFile = req.file.path;
  const preroll  = parseFloat(req.body.preroll||'4.0');
  const tail     = parseFloat(req.body.tail||'1.5');
  const ratio    = req.body.ratio||'16:9';
  const captions = req.body.captions==='1';
  let capData = [];
  if (captions && req.body.captionData) { try{capData=JSON.parse(req.body.captionData);}catch(e){} }

  const is916 = ratio==='9:16';
  const is910 = ratio==='9:10';
  const outW = is916 ? 540 : is910 ? 540 : 960;
  const outH = is916 ? 960 : is910 ? 600 : 540;
  console.log(`[${jobId}] CUT: ${clips.length} clips | ${ratio} | captions:${captions}`);

  const segFiles=[], results=[];
  try {
    const duration = await getVideoDuration(inputFile);
    for (let i=0; i<clips.length; i++) {
      const c = clips[i];
      const rawStart = Math.max(0, c.start_sec - preroll);
      const rawEnd   = Math.min(duration, c.end_sec + tail);
      // Guard: end must be after start
      const start = Math.min(rawStart, rawEnd - 1);
      const end   = Math.max(rawEnd, rawStart + 1);
      if (end <= start) {
        console.log(`[${jobId}] Clip ${i+1} skipped — invalid range ${start}→${end}`);
        continue;
      }
      const segPath = path.join(TMP, `seg_${jobId}_${i}.mp4`);
      console.log(`[${jobId}] Clip ${i+1}: ${start.toFixed(1)}→${end.toFixed(1)}s`);

      // DEBUG: skip all filters temporarily
      let vf = [];
      // if (is916 || is910) {
      //   vf.push(`scale='trunc(oh*a/2)*2':${outH}`, `crop=${outW}:${outH}`);
      // } else {
      //   vf.push(`scale=${outW}:${outH}`);
      // }
      if (captions && capData[i]?.text) {
        const txt = capData[i].text.replace(/[':]/g,' ').replace(/\[|\]/g,'');
        const fs2=is916?36:24, boxY=`h-${is916?150:80}`, boxH=is916?130:70;
        vf.push(`drawbox=y=${boxY}:color=black@0.75:width=iw:height=${boxH}:t=fill`);
        vf.push(`drawtext=fontfile=/usr/share/fonts/truetype/noto/NotoSansTelugu-Regular.ttf:text='${txt}':fontsize=${fs2}:fontcolor=white:x=(w-text_w)/2:y=${boxY}+18:line_spacing=8`);
      }

      await cutClip(inputFile, segPath, start, end-start, vf.length > 0 ? vf.join(',') : null);
      segFiles.push(segPath);
      results.push({ index:i, start, end, duration:end-start });
    }

    const outputPath = path.join(TMP, `merged_${jobId}.mp4`);
    if (segFiles.length===1) fs.copyFileSync(segFiles[0], outputPath);
    else await mergeClips(segFiles, outputPath);

    const sizeMB  = (fs.statSync(outputPath).size/1024/1024).toFixed(1);
    const elapsed = ((Date.now()-startTime)/1000).toFixed(1);
    const token   = `${jobId}`;
    pendingDownloads.set(token, outputPath);
    setTimeout(()=>{ [outputPath,inputFile,...segFiles].forEach(f=>{try{fs.unlinkSync(f);}catch(e){}}); pendingDownloads.delete(token); }, 10*60*1000);

    console.log(`[${jobId}] Done: ${elapsed}s ${sizeMB}MB`);
    res.json({ success:true, downloadUrl:`/download/${token}`, sizeMB, elapsedSec:elapsed, clips:results });

  } catch(err) {
    [inputFile,...segFiles].forEach(f=>{try{fs.unlinkSync(f);}catch(e){}});
    console.error(`[${jobId}] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/download/:token', (req,res)=>{
  const p = pendingDownloads.get(req.params.token);
  if (!p||!fs.existsSync(p)) return res.status(404).json({error:'Expired'});
  res.setHeader('Content-Disposition',`attachment; filename="kaizer_${req.params.token}.mp4"`);
  res.setHeader('Content-Type','video/mp4');
  res.sendFile(p);
});

function extractAudio(inp,out) {
  return new Promise((resolve,reject)=>{
    ffmpeg(inp).noVideo().audioChannels(1).audioFrequency(16000).audioCodec('pcm_s16le')
      .output(out).on('end',resolve).on('error',reject).run();
  });
}
function getVideoDuration(f) {
  return new Promise((resolve,reject)=>{
    ffmpeg.ffprobe(f,(err,meta)=>{ if(err) return reject(err); resolve(meta.format.duration||0); });
  });
}
function cutClip(input, output, startSec, durationSec, vfArg) {
  return new Promise((resolve, reject) => {
    try {
      let cmd = `ffmpeg -y -ss ${startSec.toFixed(3)} -i "${input}" -t ${durationSec.toFixed(3)}`;
      if (vfArg && vfArg.trim()) {
        cmd += ` -vf "${vfArg}" -c:v libx264 -c:a aac -preset ultrafast`;
      } else {
        cmd += ` -c:v libx264 -c:a aac -preset ultrafast`;
      }
      cmd += ` -avoid_negative_ts make_zero -movflags +faststart "${output}" 2>&1`;
      console.log(`[FFmpeg CMD] ${cmd}`);
      const out = execSync(cmd, { maxBuffer: 50*1024*1024 });
      resolve();
    } catch(e) {
      const msg = e.stdout?.toString() || e.stderr?.toString() || e.message;
      console.error('[FFmpeg FAIL]', msg.slice(-500));
      reject(new Error(msg.slice(-300)));
    }
  });
}
function mergeClips(segs, out) {
  return new Promise((resolve, reject) => {
    try {
      const list = out + '.txt';
      fs.writeFileSync(list, segs.map(f => `file '${f}'`).join('\n'));
      const cmd = `ffmpeg -y -f concat -safe 0 -i "${list}" -c copy -movflags +faststart "${out}" 2>&1`;
      execSync(cmd, { maxBuffer: 50*1024*1024 });
      try { fs.unlinkSync(list); } catch(e) {}
      resolve();
    } catch(e) {
      const msg = e.stdout?.toString() || e.message;
      reject(new Error(msg.slice(-300)));
    }
  });
}

app.listen(PORT,()=>{
  console.log(`Kaizer Cutter v2.1 on port ${PORT}`);
  try{console.log('FFmpeg:',execSync('ffmpeg -version 2>&1').toString().split('\n')[0]);}catch(e){}
  try{console.log('Python:',execSync('python3 --version 2>&1').toString().trim());}catch(e){}
});
