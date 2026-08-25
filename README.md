# Travafa Marketing Automation

Proof-of-concept + working notes for automating Instagram/Facebook posting and comment-to-DM engagement for Travafa. This repo is the **test harness** — the real production pipeline (calendar, admin approval, scheduling) is a separate build that comes after everything here is validated.

## Objective

Automate Travafa's daily Instagram/Facebook content:
1. **Generate** a post (image or video) from a topic, using Gemini for the prompt and Veo 3.1 / Imagen for the media
2. **Route it through admin approval** (approve / reject / revise-with-feedback) before anything goes live
3. **Publish** the same approved content to Instagram and Facebook
4. **Turn comments into leads** — a post carries a keyword CTA ("Comment TRAVAFA"), a real comment triggers an automatic DM with an offer + a tracked link back to travafa.com

The goal metric for the comment feature specifically: **link clicks to travafa.com**, not just engagement.

## Pipeline design (target architecture)

```
Calendar sheet (topic + format)
   → Gemini expands topic into a full prompt + caption
   → Veo 3.1 (video) or Imagen (image) generates the asset
   → uploaded to GCS, gets a temporary public/signed URL
   → admin reviews in travafa-admin (approve / reject / revise)
        revise → feedback fed back into the prompt step, regenerated, capped at 3 attempts
   → approved → published to Instagram + Facebook via the Meta Graph API
   → [Phase 2] comment on the post → keyword match → webhook →
        rich card DM (offer + tracked link) via Meta Private Reply
   → click logged first-party (go.travafa.com redirect) → GA4
```

Orchestration: two GitHub Actions schedules (daily generate-and-submit, and a 15-minute poll for admin decisions) — no VM to provision or maintain, confirmed to run free at our volume.

## What's in this repo

| File | Purpose |
|---|---|
| `test-veo.js` | Generates a video with Veo 3.1 from a prompt |
| `upload-to-gcs.js` | Uploads a local file to GCS, returns a public URL (pending real GCS credentials) |
| `publish-instagram-video.js` | Publishes a video/Reel to Instagram (`npm run publish-ig-video`) |
| `publish-facebook-photo.js` / `publish-facebook-video.js` | Publishes to the Facebook Page |
| `webhook-test.js` | Local webhook receiver for testing comment events (pairs with `cloudflared` for a public URL) |
| `meta-setup-runbook.html` *(published artifact)* | Full step-by-step Meta Developer setup guide, with every real error hit and its fix |
| `advanced-access-playbook.html` *(published artifact)* | Standard vs Advanced Access, real rate limits, Business Verification + App Review checklist, Veo/Vertex billing |
| `DEMO_COMMANDS.md` | Copy-paste command sequence for a live demo |

## What's actually been proven, hands-on

✅ **Publishing works today, no App Review needed.** Both Instagram and Facebook, both image and video, published successfully using Standard Access (an app in Development Mode, with our own account added as an Instagram Tester / Page admin).

❌ **Reading comments does not work without Advanced Access — confirmed exhaustively, not assumed.** Tested every angle before accepting this:
- Different commenting account, and our own account commenting on its own post
- Image post and video/Reel post
- Plain `GET /comments` and a fully verified, subscribed webhook (via a real `cloudflared` tunnel)
- Dashboard-level "Webhook Subscription" toggle turned on

All of it returned empty. This contradicts a literal reading of Meta's docs ("Standard Access covers accounts you own") — our own testing is stricter than the documented theory, so **treat comment-reading as fully gated behind Advanced Access, no exceptions**, regardless of what the docs imply should work for a tester's own content.

## Key decisions made, and why

| Decision | Choice | Why |
|---|---|---|
| Video/image generation | Gemini API (AI Studio), not Vertex — *unless run through the company's existing Vertex project* | Same models, same price; Vertex only pays off with existing GCP infra (which the company has) |
| Storage | Google Cloud Storage, same project as Veo | Reuses billing/credentials already open; cost is near-zero at this volume regardless of provider |
| Orchestration | GitHub Actions, not a VM or n8n | Effectively free at our volume (~1,600 min/month, under the free tier); n8n's own execution-count pricing would exceed its $24/mo tier just from the 15-minute poll job |
| Admin review UI | Existing `travafa-admin` app (two new API endpoints), not a new dashboard or a Telegram bot | Reuses infra the team already operates and trusts |
| Publishing method | Direct Meta Graph API calls, not a middleware SaaS (Blotato/Ayrshare) | No recurring third-party fee; App Review turned out to be a one-time cost, not a blocker, for the publish half |
| Comment trigger | Fixed keyword ("Comment TRAVAFA"), not AI intent classification | The CTA already tells people what to type — more reliable and free, no model call needed |
| Deep linking (app-installed users) | Branch.io, with web fallback instead of App Store redirect | Avoids losing interested people to install friction; free tier likely covers current scale — confirm against the app's actual MAU before committing, since Branch bills against total app MAU, not just this campaign's clicks |
| Click tracking | First-party `go.travafa.com` redirect logs the click before forwarding to GA4 | Instagram's in-app browser sometimes strips UTM params — the redirect guarantees a count GA4 alone might miss |

## Costs, planning numbers

- **Veo 3.1 generation**: $0.15/sec (Fast) to $0.40/sec (Standard); audio included, no extra charge. Realistic monthly range **$20–$96/month** depending on tier and whether every day gets a video or alternates with a cheaper image day. Full breakdown and scenarios in `advanced-access-playbook.html`.
- **Imagen images**: $0.02–$0.24 each — negligible next to video.
- **Storage, orchestration compute, Meta's own API**: effectively free at this volume.
- **Vertex AI vs Gemini API**: identical per-second pricing — routing through the company's existing Vertex project changes who's billed, not how much.

## What's required before the real build goes further

1. **Company GCP/Vertex access** — project ID, `Vertex AI User` role, confirmation Veo 3.1 is enabled in that project's region.
2. **Business Verification** (Meta) — legal documents matching Business Manager's on-file details exactly; ~3–7 business days. Must happen *before* App Review, not after.
3. **App Review, Advanced Access** — required specifically for `instagram_business_manage_comments` and `instagram_business_manage_messages` (the comment-to-DM half). Publishing permissions are already confirmed fine on Standard Access. Realistic timeline: 2–6 weeks, budget for the long end and more than one review round.
4. **`travafa-admin` changes** — two new API endpoints + new fields on the post record (status, feedback, attempt number).
5. **GCS service account key** — still pending; today's tests hosted media via a public GitHub repo as a stand-in.

## Current status

| Stage | Status |
|---|---|
| 01–07 (calendar → generation → admin review) | Designed, not yet built |
| 08 (publish to Instagram + Facebook) | **Proven working** on Standard Access, ready to build for real |
| 09 (comment → DM) | Fully designed, blocked on Business Verification + App Review — not a build problem, a policy gate |

## Demoing this today, without waiting on App Review

The comment-to-DM *mechanism* can be demoed live right now using Meta Business Suite's native "Comment to Message" automation (free, built into Meta's own product, no developer app involved) or a Meta-approved third party like ManyChat. Neither of these unblocks our own app's Advanced Access — they're separate, already-approved systems standing in for a live demo while our own review is pending.

## Reference docs

- **Meta API Setup Runbook** — every setup step, in order, with the real errors hit and how they were fixed
- **Advanced Access Playbook** — Standard vs Advanced Access, real rate limits, Business Verification + App Review checklist, Veo/Vertex billing

*(Both are published Claude artifacts from this session — ask for the links if you need them again.)*
