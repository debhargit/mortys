# Vision Auto Solutions: 30-second website ad

| File | What it is |
|---|---|
| `Vision-Auto-Ad-16x9.mp4` | 1920×1080, 30 s, for YouTube, Facebook and the TV in the shop |
| `Vision-Auto-Ad-9x16.mp4` | 1080×1920, 30 s, for Instagram Reels, TikTok and WhatsApp Status |
| `ad.html` | The animated ad as a web page. Open it in Chrome and click Play. Add `?f=v` for the vertical version |
| `ad-audio.m4a` | The finished soundtrack: voice-over plus music |
| `shots/` | Screenshots of visionautosolutions.com taken on 20 Oct 2026, plus the logo |

Brand: red `#d62828`, navy `#0b1b2b`, and the site's yellow `#ffc300` as the highlight colour. Headlines use Bebas Neue, as on the home page. Body text is Inter.

## Script and storyboard

| Time | Picture | Voice-over | On-screen text |
|---|---|---|---|
| 0:00–0:02 | The logo spins in on a white badge over navy, with red and yellow racing stripes | "Need a car part, today?" | NEED A CAR PART? **TODAY?** |
| 0:02–0:07 | Home page in a browser (phone frame in 9:16). Counters run up | "Vision Auto Solutions has over thirty-six thousand parts online, and ten thousand on the shelf right now." | **36,500+** PARTS ONLINE. **10,800+** ON THE SHELF. |
| 0:07–0:11 | Zoom into the vehicle finder filled in: Toyota · Corolla · 2019 · "brake pads" ("3,062 parts listed for the Toyota Corolla") | "Pick your make, model and year, and see what fits your car." | MAKE. MODEL. **YEAR.** · chip: *See what fits your car* |
| 0:11–0:15 | Pan down the "In stock at the counter" cards with their "Ask for a price" buttons | "Engine, brakes, suspension, wheels, ask for a price in one tap." | ENGINE. BRAKES. SUSPENSION. **WHEELS.** · chip: *Ask for a price in one tap* |
| 0:15–0:19 | Zoom into "Visit us on Waltham Park Road": WhatsApp, phone, email | "Can't find it? WhatsApp us your VIN, and we'll source it." | WE'LL **SOURCE IT.** · green chip: *WhatsApp your VIN: 876-553-4458* |
| 0:19–0:22 | The Track Your Service page | "Same-day pickup, and islandwide delivery." | SAME-DAY PICKUP. **ISLANDWIDE DELIVERY.** · chip: *Track your service online* |
| 0:22–0:30 | End card: logo, name, "Your auto parts visionary · Since 2017", web address, a pulsing phone button, address | "Vision Auto Solutions, Waltham Park Road, Kingston. Call eight seven six, seven two eight, forty-seven thirty-five." | **visionautosolutions.com** · **(876) 728-4735** · 112C Waltham Park Road, Kingston, Jamaica |

Every line of the voice-over also appears as a subtitle, so the ad works with the sound off. A red-and-yellow wipe covers each cut.

**Voice-over, read straight through (about 26 seconds):**

> Need a car part, today?
> Vision Auto Solutions has over thirty-six thousand parts online, and ten thousand on the shelf right now.
> Pick your make, model and year, and see what fits your car.
> Engine, brakes, suspension, wheels, ask for a price in one tap.
> Can't find it? WhatsApp us your VIN, and we'll source it.
> Same-day pickup, and islandwide delivery.
> Vision Auto Solutions, Waltham Park Road, Kingston. Call eight seven six, seven two eight, forty-seven thirty-five.

Line start times: 0.3 s, 2.1 s, 7.3 s, 10.9 s, 15.6 s, 19.4 s and 22.1 s.

## Audio

- **Voice:** the Windows built-in "Microsoft David" voice. It sounds synthetic. For a warmer local read, record the lines above on a phone and line each one up at its start time. Then save the mix over `ad-audio.m4a` and re-render.
- **Music:** an original 112 BPM track made for this ad: kick, offbeat chord stabs, bass, Am–F–C–G. Nothing is sampled or licensed, so it is free to use anywhere. The music drops under the voice automatically.

## Left out on purpose

- **Parts assistant chat:** it is not switched on yet. The live site replies "not ported to Cloudflare yet", and it is off on the till too. The ad shows WhatsApp and "we'll source it" instead. Add a chat scene once the assistant is live.
- **Customer reviews:** the Reviews page currently shows 0 verified reviews, so the ad quotes none.
- **Shop product photos:** most catalogue items show "No photo", so the shopping scene uses the home page's "In stock at the counter" cards.

## Re-rendering after a change

Edit the words in `ad.html`. The `SUBS` list holds the subtitles, and each scene is in its own block (`// 1 ----`, `// 2 ----` and so on). Then capture `ad.html?render=1` (add `&f=v` for vertical) at 30 fps by calling `seek(t)` for each frame. Use headless Chrome with puppeteer-core, pipe the frames to ffmpeg with `ad-audio.m4a` as the soundtrack, and encode with H.264 at CRF 18.
