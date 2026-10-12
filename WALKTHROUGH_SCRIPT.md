# Clearway: 5–8 Minute Video Walkthrough Script (Loom / Screenshare)

> **Target Duration:** 6 to 7 minutes (safe within the 5–8 minute window)  
> **Format:** Spoken script with exact on-screen visual directions `[Visual: ...]` and mouse action cues.  
> **Speaker Notes:** Speak naturally, at an unhurried conversational pace. Pause briefly when transitioning between screens.

---

## Quick Reference / Presenter Cheat Sheet

Before hitting record, keep these facts in mind:
- **Routes:** 3 alternatives (TomTom truck profile with 65 mph governed speed, fallback to OSRM + lateral via-point synthesis).
- **Checkpoints:** 10, 25, or 50-mile intervals with ETA-matched weather lookups.
- **Weather API:** Open-Meteo hourly forecast blend (instantaneous wind interpolated linearly; cumulative precipitation binned to preceding hour).
- **Load Rules:**
  - $\ge 55\text{ mph}$ $\rightarrow$ **No Travel** (any load)
  - $45\text{--}54\text{ mph}$ with $> 30,000\text{ lb}$ $\rightarrow$ **No Travel**
  - $35\text{--}44\text{ mph}$ with $> 40,000\text{ lb}$ $\rightarrow$ **Severe**
- **Recommendation Hierarchy:** `Fewest No Travel miles` $\rightarrow$ `Fewest Severe miles` $\rightarrow$ `Fewest High miles` $\rightarrow$ `Lowest average risk` $\rightarrow$ `Shortest travel time`.
- **Corridor Heatmap:** GPU-accelerated HTML5 canvas source rendered directly into MapLibre GL at a steady 60 FPS.
- **Tests:** 130 backend unit tests (`pytest`), 9 frontend unit tests (`vitest`).

---

## Walkthrough Breakdown & Timeline

```
[0:00 - 0:45]  Introduction & Core Problem Solved
[0:45 - 2:30]  Live Demo: Planning, Recommendation & Checkpoints
[2:30 - 4:15]  Interactive Corridor Heatmap & 48-Hour Timeline Scrubber
[4:15 - 6:00]  Under the Hood: Architecture, Risk Rules & API Optimization
[6:00 - 7:00]  Testing, Production Deployment & Conclusion
```

---

## Script

### 1. Introduction & Overview (0:00 – 0:45)

**[Visual: Start with the browser open to the Clearway landing page. The map is centered over North America, and the trip planning form is visible on the left.]**

**Spoken Script:**
> "Hi everyone, and welcome to my walkthrough of **Clearway**, a full-stack weather-aware truck routing platform built for the Spotter assessment.
> 
> In commercial freight, weather isn't just an inconvenience—it's a critical safety hazard. A gust that a passenger car barely feels can tip an empty or top-heavy 53-foot tractor-trailer. But weather is dynamic: what matters isn't what the weather is doing right now at departure, but what the conditions will be hours later when the truck actually reaches a mountain pass or a coastal bridge.
> 
> Clearway solves this by generating three distinct route options, sampling weather at checkpoints along each route matched specifically to the truck's estimated arrival time, applying strict cargo-weight risk rules, and recommending the safest overall journey."

---

### 2. Live Demo: Trip Planning & Recommendation (0:45 – 2:30)

**[Visual: Move mouse to the sidebar form. Click the preset example "New Orleans, LA → Jacksonville, FL" or type it into Origin and Destination. Set Departure to current time and Load Weight to 42,000 lbs. Checkpoint interval to 25 mi.]**

**Spoken Script:**
> "Let's run a live scenario. I'll pick an interstate freight route from New Orleans to Jacksonville. We'll set our departure to right now, a cargo load weight of 42,000 pounds—a typical heavy trailer—and a 25-mile checkpoint interval.
> 
> When I click **Plan trip**, Clearway contacts our Django backend, computes three alternative routes, and queries the Open-Meteo forecast models for every checkpoint along each route."

**[Visual: Click 'Plan trip'. Within 1–2 seconds, the map renders all three routes in colored lines with checkpoints, and the results sidebar populates. Point mouse to the top 'Recommended' banner and the route cards.]**

**Spoken Script:**
> "Let's look at what the recommendation engine gave us.
> 
> Notice that **Route A** is marked as **Recommended**, even though it might be slightly longer or have some severe stretches. Why? Look at Route B and Route C below it. Both Route B and Route C cross **No Travel** conditions along the Gulf Coast.
> 
> In freight safety, avoiding a 'No Travel' event trumps all other factors. Our recommendation engine applies a strict lexicographical ranking:
> 1. Fewest No Travel miles
> 2. Fewest Severe miles
> 3. Fewest High-risk miles
> 4. Lowest average risk index
> 5. And finally, shortest travel time.
> 
> Because B and C have No Travel miles, Route A wins outright."

**[Visual: Click on the 'Checkpoints' tab or expand the checkpoint list in the sidebar. Hover over or click a checkpoint with an elevated risk tag.]**

**Spoken Script:**
> "If we expand the checkpoint list, we can inspect each point along the journey. Every checkpoint displays its exact mileage, estimated time of arrival, sustained wind speed, rain and snow rate, and the exact reason for its risk tier.
> 
> Notice this checkpoint: it flags **Severe Risk** due to **'Wind 38 mph with 42,000 lb load'**. Under standard rules, 38 mph is classified as High. But because our truck is carrying over 40,000 lbs, our cargo-weight escalation rule upgraded it to Severe.
> 
> Furthermore, when I click any checkpoint in this list, notice how the map immediately flies to that location, opens an inspector popup, and syncs our timeline to that checkpoint's arrival time."

---

### 3. Interactive Corridor Heatmap & 48-Hour Timeline Scrubber (2:30 – 4:15)

**[Visual: Direct attention to the bottom 'Timeline Dock' and the Heat Controls on the map. Click the 'Play' button or drag the slider across the 48-hour timeline.]**

**Spoken Script:**
> "One of the standout requirements of this challenge is the **0 to 48-hour corridor weather heatmap**.
> 
> Down here on the timeline dock, you see the entire 48-hour window from departure. Each route has its own miniature hazard bar showing risk exposure along the trip duration.
> 
> Watch what happens when I drag the slider or press Play.
> 
> The truck marker advances along the highway according to its driving time, and the underlying weather heatmap updates dynamically in real-time. Notice how smooth this playback is—we are getting a rock-solid 60 frames per second without any stutter or map re-rendering."

**[Visual: Switch the Heat Layer dropdown between 'Risk Index', 'Wind', 'Rain', and 'Snow'. Zoom and pan the map slightly while the heat overlay remains responsive.]**

**Spoken Script:**
> "We can toggle between layers: Risk Index, Sustained Wind, Rain, and Snow.
> 
> Implementing this performantly was a major engineering focus. Rather than shipping heavy GeoJSON polygons or requesting hundreds of raster tiles that would choke the browser and hit API rate limits, our backend computes a compact Web Mercator corridor grid.
> 
> On the frontend, we paint that grid into an off-screen HTML5 canvas—one pixel per grid cell—and feed it directly to MapLibre as a dynamic canvas source. MapLibre's WebGL linear filtering blends the neighboring cells into a smooth continuous gradient on the GPU. Scrubbing the timeline just repaints a tiny array of pixels, which keeps the UI blazing fast."

---

### 4. Technical Architecture & Correctness (4:15 – 6:00)

**[Visual: Switch screens to VS Code / code editor. Open `backend/planner/risk.py` and `backend/planner/weather.py`.]**

**Spoken Script:**
> "Now let's look under the hood at how the backend ensures precision and reliability.
> 
> Here in `backend/planner/risk.py`, we implement the assessment's risk rules:
> - Wind thresholds: Low below 25 mph, Moderate up to 34, High up to 44, Severe up to 54, and No Travel at 55 and above.
> - Rain and snow thresholds with strict boundary handling.
> - And the critical load escalations: 45–54 mph becomes No Travel if gross cargo exceeds 30,000 lbs, and 35–44 mph escalates to Severe if cargo exceeds 40,000 lbs.
> 
> Every boundary is strictly tested against inclusive lower bounds and strict upper bounds."

**[Visual: Switch to `backend/planner/weather.py` and scroll to interpolation logic.]**

**Spoken Script:**
> "Another subtle challenge is weather time-binning.
> 
> In meteorological models like Open-Meteo, wind speed is an instantaneous observation, whereas precipitation totals are cumulative over the preceding hour.
> 
> In `weather.py`, we handle this properly:
> - Wind speed and temperature are interpolated linearly between the surrounding hours to match the exact ETA minute.
> - Rain and snow rates are assigned to the exact 1-hour interval that contains the truck's arrival time. If a truck arrives at 14:20, it receives the 14:00 to 15:00 total.
> 
> We also respect Open-Meteo's API budget: we snap checkpoints to a 0.05-degree coordinate lattice, cache forecasts for 30 minutes, and de-duplicate queries so we never breach the free tier's 600-call-per-minute rate limit."

**[Visual: Switch briefly to `backend/planner/alternatives.py`.]**

**Spoken Script:**
> "For routing, if the primary routing provider returns fewer than three routes—which often happens on long interstate hauls—`alternatives.py` synthesizes viable alternatives by projecting lateral via-points perpendicular to the primary corridor, routing through them, and automatically trimming any out-and-back spurs. This guarantees the driver always gets three genuine choices."

---

### 5. Testing, Production Deployment & Wrap-Up (6:00 – 7:00)

**[Visual: Switch to terminal window. Run the test commands or show clean test output.]**

**Spoken Script:**
> "Code quality and test coverage were top priorities throughout development.
> 
> In the backend, we run `uv run pytest`. We have **130 passing unit tests** covering every risk boundary, load rule combination, checkpoint interpolation, spur trimming, and API resilience with mocked HTTP fixtures.
> 
> On the frontend, we have Vitest tests covering ETA interpolation, geometry slicing, and heatmap rendering, alongside full TypeScript type checking and linting.
> 
> For deployment, the entire application is containerized in a multi-stage `Dockerfile`. Node builds the optimized React frontend, and Django serves both the API and the static assets through WhiteNoise with Brotli and Gzip compression, configured with `render.yaml` for one-click hosting on Render.
> 
> To summarize: Clearway delivers an accurate, time-synced weather risk analysis and route recommendation for truckers, backed by robust algorithms and a smooth 60 FPS visualization.
> 
> Thank you for your time, and I look forward to your questions!"

**[Visual: End screenshare on the Clearway app interface or project README.]**

---

## Filming Checklist & Tips
- [ ] **Resolution:** Record at 1080p (1920x1080) for sharp text readability.
- [ ] **Tab Setup:** Have two browser tabs ready: (1) Local/hosted Clearway app, and (2) VS Code with `risk.py`, `weather.py`, and terminal split.
- [ ] **Audio Check:** Do a 10-second test recording to verify microphone levels and eliminate background noise.
- [ ] **Pacing:** If you find yourself speaking fast, slow down slightly during the heatmap demonstration—watching the 60 FPS animation scrub smoothly speaks for itself!
