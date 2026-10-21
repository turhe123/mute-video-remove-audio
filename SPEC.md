# Mute Video and Remove Audio — specification

**Tagline:** Strip the sound from a video in your browser without re-encoding, with no watermark and no upload.

**Category:** Audio & Video

**Free alternative to:** Clideo Mute Video and Kapwing Remove Audio from Video (uploads your video to their cloud, watermark on free exports, file size limit, sign-up for removal of watermark)

**Search phrases:** remove audio from video, mute video online, remove sound from video, strip audio from mp4, video without audio, mute mp4, delete audio track from video

**Allowed libraries:** ffmpeg

**Published at:** https://turhe123.github.io/mute-video-remove-audio/

## Acceptance checks (each must have a test)

- Dropping sample-video.mp4 and pressing Remove audio downloads a new .mp4
- The output plays in the page preview with the volume control reporting no audio track or silence
- The result shows original and output size, which are nearly equal because video is copied
- A video that already has no audio shows an informational note
- A non video file shows an error
- Works at 390px wide

## Spec

People often need a silent version of a clip to post as a background, remove copyrighted music before sharing, protect privacy by removing overheard speech, or shrink slightly for upload. They search for remove audio from video, mute video online and mp4 without sound. Popular online muters upload the full video to their cloud, apply file size limits, add a watermark on the free export, and ask for an account to remove it. Private footage, such as family videos or screen recordings with confidential talk, is the worst thing to upload. Our version removes the audio track locally.

Feature set: load one video file (MP4, MOV, M4V, WebM, MKV). The tool copies the video stream untouched into a new container with the audio streams dropped, so there is no quality loss and it is fast. Show the detected duration, resolution and whether an audio track exists. Provide a second option Keep audio but silence it, off by default, which is not needed for most users, so leave it out and keep one job. Output named with the suffix muted and the same extension.

UI: a drop zone and choose file button above the fold. After loading, a preview video player and a small info card with name, size, duration and audio yes or no. One primary button, Remove audio. A progress bar appears while ffmpeg loads and runs. The result card shows output size, a preview player and a Download button. Empty state states that the file never leaves the computer. Errors cover unsupported container, out of memory and a missing audio track. Keyboard: Enter starts, space plays the preview.

Technical approach: use the vendored ffmpeg 0.12.10 wasm build in a worker. Write the input file into the virtual file system, run the arguments to copy the video stream and disable audio, in other words input, video codec copy, audio none, then read the output file and make a Blob with the matching MIME type. Show progress from ffmpeg progress events. Load ffmpeg lazily only after a file is chosen, since the core is large, and show a loading note on first use. Because the wasm threads variant needs cross origin isolation, which GitHub Pages cannot send as headers, use the single threaded core and say it may be slower on large files. A file size ceiling of about 2 GB is stated honestly given memory limits, with a warning above 500 MB.

Edge cases: files with many streams such as subtitles are dropped or kept as ffmpeg defaults allow, and the note tells the user. MOV files from iPhones use HEVC, which copies fine but may not preview in every browser, so preview failure must not block download. Variable frame rate and rotation metadata are preserved by copying. Mobile Safari memory is tight so large files may fail with a clear message. Unicode names are preserved.

Demo data: a bundled six second generated video called Sample Video with a moving square and a beeping tone, so users can compare the original and the muted result.
