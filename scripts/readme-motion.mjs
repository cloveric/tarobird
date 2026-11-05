// Record the actual renderer during documentation interactions. The authoring
// fixture supplies synthetic content; this helper only samples and encodes it.
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';

export async function recordReadmeMotion(page, directory, output, actions) {
  await mkdir(directory, { recursive: true });
  const frames = []; let stopped = false;
  const recording = (async () => {
    while (!stopped) {
      const file = `frame-${String(frames.length).padStart(5, '0')}.png`, at = Date.now();
      await page.screenshot({ path:path.join(directory,file), animations:'allow' });
      frames.push({ file, at });
      await new Promise(resolve => setTimeout(resolve, 125));
    }
  })();
  try { await actions(); } finally { stopped = true; await recording; }
  if (frames.length < 2) throw new Error('Documentation recording has no motion frames');
  const end = Date.now();
  const list = frames.map((frame, index) => `file '${frame.file}'\nduration ${((frames[index + 1]?.at ?? end) - frame.at) / 1000}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
  await writeFile(path.join(directory, 'frames.txt'), list);
  const input = ['-f','concat','-safe','0','-i','frames.txt'];
  const run = args => promisify(execFile)('ffmpeg', ['-y','-v','error',...args], { cwd:directory, maxBuffer:10*1024*1024 });
  await run([...input,'-vf','fps=8,scale=1248:-2:flags=lanczos,pad=1280:ih+32:16:16:color=0xf3f2f0,palettegen=max_colors=192:stats_mode=diff','palette.png']);
  await run([...input,'-i','palette.png','-lavfi','fps=8,scale=1248:-2:flags=lanczos,pad=1280:ih+32:16:16:color=0xf3f2f0[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle','-loop','0',output]);
  if (process.env.DEMO_KEEP) {
    await run([...input,'-vf','fps=8,scale=1248:-2:flags=lanczos,pad=1280:ih+32:16:16:color=0xf3f2f0','-c:v','libx264','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart','preview.mp4']);
    await copyFile(path.join(directory,'preview.mp4'), path.join(process.env.DEMO_KEEP, path.basename(output,'.gif')+'.mp4'));
  }
  const bytes = await readFile(output);
  return { file:path.basename(output), frames:frames.length, duration:(end-frames[0].at)/1000, bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex') };
}
