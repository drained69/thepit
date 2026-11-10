You are my motion designer. Make a product demo video for The Pit, a memecoin launchpad on NEAR
where every coin is fully backed by its own reserve, that reserve is staked with validators, and the
yield pays for the coin's own AI. It is for memecoin creators and buyers who are tired of rugs, sniped
launches and tokens that do nothing after day one.

You have access to this repo. Before designing anything, read it so the video shows the real product:

* What it is and how it works: README.md (How it works, Economics, Built on NEAR, Design decisions,
  Security, FAQ) and docs/architecture.md
* Screens and copy: webapp/src/pit/ThePitApp.tsx (nav, home, launch builder, coin page, docs/FAQ),
  webapp/src/pit/Trade.tsx (buy, sell, early-access pass flow and its error messages),
  webapp/src/pit/Mind.tsx (thoughts, "Verify it yourself", canon, "Teach it"),
  webapp/src/pit/Curve.tsx, webapp/src/pit/Portfolio.tsx, webapp/src/pit/Payouts.tsx
* Brand: webapp/src/pit/pit.css (colour tokens, radii, card and terminal styles) and
  webapp/src/pit/Logo.tsx (the mascot logo: a brain with googly eyes climbing out of a pit)
* The demo data: webapp/src/pit/chain.ts (SAMPLE_COINS, SAMPLE_STATS, SAMPLE_LAUNCH, SAMPLE_FEED)
  and the sample thoughts and memories at the top of webapp/src/pit/Mind.tsx
* What happens underneath: pit/contracts/pit/src/ (trading.rs, staking.rs, payouts.rs, mind.rs),
  pit/contracts/factory/src/lib.rs, pit/gate-agent/src/gate.mjs (the challenge prompt and proof of
  work), pit/brain/README.md and pit/brain/tiers.json (one model per brain tier)
* Run it yourself: `npm ci --prefix webapp`, then `npm --prefix webapp run dev`. With no factory
  configured it opens in preview mode with sample markets and a "Demo mode" banner. Click through the
  home page, a coin page (open $PIT, which is in its gated window), the launch builder, the mind
  panel and the How it works page. Recreate what you see.
* Preview mode disables wallet actions, so the pass flow, buy, sell, propose and back screens never
  render there. Rebuild those from the code paths in Trade.tsx and Mind.tsx with their exact strings.

Use these exactly:

* Show the real screens in the order a real user meets them, with the exact words on them. Do not
  invent UI copy. Your own captions can be new writing, but must stay true to what the code does.
* Tagline: "Every coin is fully backed, its reserve is staked, and the yield feeds the coin's own AI."
* Hero headline (the app's own): "Memecoins with a mind of their own."
* Fonts: Manrope and JetBrains Mono (Google Fonts, the weights webapp/index.html loads:
  Manrope 300–700, JetBrains Mono 400–600).
* Colours, from pit.css: background #101115, surfaces #15171e / #191c24 / #1d212b, lines #2a2e3a /
  #373d4c, text #f4f5f8 / #bcc4d3 / #a2acbf, lime accent #e7fc91 (headline highlights and primary
  buttons), green #69e3a6 for buys, approvals and "staked", red #ff898e for sells and rejections,
  amber #f5c879 for waiting and "Preview", violet #9785e9, and brain lilac #cabaff for everything
  to do with the AI. The logo's rim gradient is #c084fc → #f7a35c and the brain is #ff9ec4. The app is
  dark only: keep the whole video dark, and use the hero's violet glow (#29243c on #181b22) for the
  open and close.

Imagine you are a creator launching a coin, then a buyer, then a holder. Walk through the product as
they would:

1. Home. The hero ("Memecoins with a mind of their own."), the four ticker cards (Pits, Backing,
   Fed, Launch) and "Explore markets" with the sample coins $PIT, Doge Pit, Frog Brain and Moon Rock.
   Point: one launchpad, where every coin is backed and has a brain.
2. Launch a coin. Open "Launch a coin" and the "Build your iMeme" form. Type a name and symbol
   (use the form's own placeholders, "Doge Pit" and "DOGE"), pick an emoji icon, choose "Require a
   pass" under Early access, and drag "Your cut of the brain's food" to a value. The "02 · Review
   launch" card updates live: "Lives at doge.pit.testnet", "Trading fee (feeds the brain) 1%", brain
   "Larva". Push in on the cost: about 0.12 NEAR, one transaction. Point: shared, hash-pinned code
   (NEAR global contracts) makes a launch cost ~0.12 NEAR instead of ~3.5, and no one can change a
   coin afterwards.
3. The sniped launch that doesn't happen. A simple terminal panel: a bot calls `buy` on $PIT during
   the gated window and gets `PassRequired`, which the app shows as "This window requires an early
   access pass." Then the human path on the coin page: "Get early access pass" → the gate's
   challenge, "One of these is not like the others. Tap it." → click the odd one out → "Proving
   you're not a farm (proof-of-work)…" → "Buy with pass", with "Pass record fee 0.002 NEAR". Show
   the contract's checks lighting up one by one: the pass is signed by the gate, the Shade agent
   registry reports that agent "Valid", the one-use nonce is burned, the per-wallet cap holds. If
   any check fails, the NEAR comes back as refund credit, not lost. Point: bots pay capital for every
   extra wallet (a challenge, a minimum balance, a per-wallet cap). Never say it proves personhood.
4. Fully backed, and staked. On the coin page show the bar under "Where the NEAR sits — holders are
   always fully backed": 80% staked with a validator, 20% liquid. A buy mints on the bonding curve.
   A small sell is paid at once from the buffer. A big sell beyond the buffer is locked at that
   moment's price and queued, then paid when staked NEAR returns. Push in on the rule from the README:
   liquid + staked + unstaking ≥ principal + queued payouts. Point: the curve can never pay out more
   than the reserve holds.
5. The brain eats. Staking rewards plus the 1% fee are harvested to the brain ("Harvested 1.000 NEAR
   of staking rewards" in Recent activity). The brain spends that budget on a thought in NEAR AI's
   TEE, records it with its signature, and the contract re-verifies the signature on-chain ("✓ proof").
   Open "Its mind, on-chain", press "Verify it yourself" and let the checks stream in. Then show the
   brain tiers growing with the reserve: Larva → Juvenile (1,000 NEAR) → Adult (10,000) → Ascended
   (100,000), each tier a larger model. Point: the coin pays for its own AI, and anyone can check that
   it wrote what it posted.
6. Holders shape it. Open "Teach it": a memory ("You are allergic to rugs.") with conviction filling
   toward its threshold as holders back it with tokens, then "Adopt" moves it into the canon the
   brain reads before every thought. Tokens unlock any time.
7. The payoff: why you can trust it. No admin keys: after deployment the factory has no access keys
   and coins never have any, so no one can withdraw the reserve, pause or upgrade. Every payout is
   confirmed by callback, and nothing is resent on a timeout. Then the evidence, counting up: 93 coin
   contract tests and 10 factory tests, a 10,000-operation randomized invariant simulation checking
   solvency after every step, and an internal audit with every finding fixed. Finish the step on the
   honest status: running on NEAR testnet, and mainnet waits for an independent audit.

How to build it:

* Use Remotion (React), so every frame is code and it renders to MP4. Put the whole project in its
  own folder (video/) at the repo root with its own package.json. Do not add anything to the
  webapp's, the root's or any pit/ package.json.
* Before writing any animation, decide how many seconds each step gets and show me the plan (aim for
  60 to 75 seconds in total). Keep it fast. Nothing slow or boring. Steps 3 and 5 are the heart of the
  story and should get the most time.
* The Pit is a desktop web app, so rebuild its interface inside a clean browser window frame (a
  generic frame, no real browser's branding), at the app's real layout and the 1180px content width.
  Use the PitLogo SVG from Logo.tsx as-is. For the bot in step 3, use a simple terminal panel. Show
  real interaction: a cursor moving with a visible click ripple, typing in the launch form, the review
  card updating as you type, the share slider moving, the challenge tiles, the contract checks ticking
  green one by one, trades and harvests streaming into Recent activity, the reserve bar filling, the
  conviction meter rising, and the brain tier badge levelling up.
* Move the camera. Push in on what matters (the ~0.12 NEAR launch cost, `PassRequired`, the
  "Valid" registry check, the 80/20 bar, the solvency rule, the "✓ proof" tag, the tier upgrade) and
  pull back between steps.
* Put a short caption beside each step: a number, a label, a headline, one supporting line. Large
  enough to read on a phone. Reuse the app's own section style (lime uppercase eyebrow, then a bold
  headline with one lime-highlighted phrase, like "Every coin gets three things").
* Let the mascot carry the personality: it drools when fed and looks hungry when the brain is
  starving (Logo.tsx has a `hungry` state). Keep the rest of the UI clean, as the app does.
* Open on the logo and tagline. Close on the logo, what the product does in three words ("Backed.
  Staked. Thinking."), and the call to action: "Star it on GitHub, github.com/drained69/thepit".
* Make the very first frame a finished cover image (logo, the hero headline, and a glimpse of a coin
  card with its brain tier and a "✓ proof" thought), because most apps use it as the thumbnail.
* Be honest about what is shown. Add a small "Testnet demo · sample data · no real money" label
  wherever coins, prices or payments appear. On testnet the validator pool and agent registry are
  mocks and the gate runs with a local key, not in a TEE: say once, in a caption, that production
  runs the gate as a Shade Agent in a TEE. Do not draw NEAR's, NEAR AI's, Phala's, RHEA's or any
  wallet's own interfaces or logos; name them in text only. Do not show the sample feed line "A
  verified human bought 176.6k PIT": the gate does not verify humans, so write that row as an
  early-access buy instead.

Sound:

* Write an original soundtrack in code so there is nothing to license. Pick a tempo (around 120 BPM,
  so one bar is two seconds) and start every section on a bar, so cuts land on the beat. Make it
  playful and confident, with a tense moment under the bot in step 3 and a lift on the brain levelling
  up and on the payoff.
* Add interface sounds: clicks, typing, a soft tick as each contract check passes, a low thud when
  the bot is rejected, a coin clink for a buy, a chime for a confirmed payout, a munch when the brain
  is fed, and a rising sound for a tier upgrade. Time them from the same file that times the visuals,
  so they can never drift apart.

Quality:

* Render review frames of every scene and check them yourself before the final export. Fix anything
  cropped, overlapping or too small to read, especially monospace account names
  (doge.pit.testnet, pit-gate-agents.testnet) and NEAR amounts with the Ⓝ sign.
* Export 1920x1080 for desktop and 1080x1920 for Instagram and X, at high quality so it survives
  compression. For the vertical version, re-lay out each scene (stack the UI and the caption). Don't
  just crop the wide one.
* All market data in the video is example data from the preview: the four sample coins, $PIT's
  2,876 NEAR backing, 46 NEAR harvested, Juvenile tier, the sample thoughts and memories. The launch
  cost, fee, 80/20 split, tier thresholds, test counts and the 10,000-operation simulation come from
  the README and the code. Label the sample data as sample, and tell me which on-screen numbers are
  examples and which are real parameters.
* Never show private data from the repo or this machine: do not read or show any .env or
  .keeper-*.env file, private keys, credentials, account secrets, API keys or email addresses, or
  anything from a real wallet.

Use your best motion design judgement throughout.
