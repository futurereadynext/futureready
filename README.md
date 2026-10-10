# Future Ready: Live Classroom Demo

A working browser-based live class: teacher camera + mic, **screen sharing**, student join by link, chat, raise hand, mute-all.
Built with plain WebRTC and a small Node.js signaling server (Express + ws). No video vendor account needed.

## Run it on your computer (2 minutes)
```bash
npm install
npm start
# open http://localhost:3000
```
1. Click **Start class**, enter your name. Allow camera and mic.
2. Click **Copy student link**, open it in another browser window (or another device on the same Wi-Fi using your computer's IP), join as a student.

## Get a public link for stakeholders

**Option A: instant (same day), your laptop stays on**
```bash
npm start
npx cloudflared tunnel --url http://localhost:3000   # or: ngrok http 3000
```
Share the https URL it prints. Camera, mic and screen share require https, which the tunnel provides.

**Option B: permanent free link (Render.com)**
1. Push this folder to a GitHub repo.
2. On render.com: New > Web Service > pick the repo. It reads `render.yaml` automatically.
3. After deploy you get `https://your-app.onrender.com`. (Free instances sleep when idle, so open it once before the demo.)

## Demo script
1. Teacher starts class with camera and mic on.
2. Share the student link; 2-3 people join from phones or laptops.
3. Teacher clicks **Share screen** (slides, browser, or whiteboard tab). Students see the screen, with the teacher camera in a corner.
4. Student raises a hand; teacher sees the alert. Try chat and **Mute all students**.

## Limits of this demo (be upfront with stakeholders)
- **Peer-to-peer (mesh):** the teacher's video uploads separately to each student. Good for about 5 to 10 students. For 50+ students, swap in an SFU service (LiveKit / 100ms): the UI here can stay.
- **Some networks block direct connections** (strict office or school firewalls). Fix with a TURN server: set env var `ICE_SERVERS`, e.g. from Twilio or Metered:
  `ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:HOST:3478","username":"U","credential":"P"}]'`
- Teacher link = the URL containing `?host=...`. Keep it private. Anyone with it joins as teacher.
- No login, recording, scheduling, payments or whiteboard yet (Phases 2 and 3).
- Screen sharing is desktop-only; phones can join and watch but not present.

## Files
- `server.js` serves the app and relays signaling, chat and state
- `public/index.html` landing page (start or join)
- `public/class.html`, `class.js` classroom
- `test/signaling.test.js` run with `npm test`
