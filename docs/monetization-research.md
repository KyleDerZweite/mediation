# Monetization research — subscription model for Mediation

**Status:** research only. Nothing in this document is implemented. No payment SDK, no
migration, no checkout, no provider account, no business registration, no tax filing.

**Date of research:** 2026-07-24, revised same day after external review. The revision
added the §356a Widerrufsbutton (§5.6.1), the B2C-vs-B2B-only decision (§5.10), the
§§327ff/BFSG obligations (§5.11), corrected the Kleinunternehmer price wording (§5.2),
made the payment-provider recommendation conditional (§3.3, §13.2), relabelled margins as
contributions with a support-cost scenario (§2.3.1), marked all tier limits provisional
(§1.1), and dropped the universal-user-email prerequisite in favour of a checkout-scoped
billing email (§11.4). Prices, thresholds and statutes change; re-verify anything material
before acting on it.

**Not legal or tax advice.** The author of this document is not a Steuerberater or
Rechtsanwalt. Items marked **[ADVISER]** must be confirmed by a German tax adviser or
lawyer before money is accepted.

## How to read the claim markers

| Marker | Meaning |
| --- | --- |
| **[FACT]** | Taken from a primary source (statute, government body, provider's own pricing/docs). Link given. |
| **[REC]** | The author's recommendation. Judgement, not fact. |
| **[ASSUMPTION]** | A number or condition assumed for modelling. Must be replaced with measurements. |
| **[ADVISER]** | Needs a Steuerberater or Rechtsanwalt before relying on it. |
| **[UNVERIFIED]** | Found in secondary sources only; primary source unavailable or not checked. |

## What the service actually is (grounding for the cost model)

Read from this repository, not assumed:

- One Node process (`src/server/index.ts`), Hono HTTP (`src/server/app.ts`), one SQLite
  file via `node:sqlite` (`src/server/store.ts`). No build step, three runtime deps.
- **No AI/model calls anywhere.** Overlap detection is string and token matching in
  `src/core/overlap.ts` (path prefix, case-insensitive component match, ≥2 shared task
  tokens). This removes the single largest variable-cost line most 2026 SaaS products
  carry. Cost exposure is CPU, disk and bandwidth only.
- **No email is sent today.** `users` holds `username`, `password_hash`, `role`,
  `status` — no email address column exists (`src/server/store.ts:237`). Billing needs a
  **verified billing contact email for paying accounts** — but that is a
  `billing_customers.billing_email` collected at checkout, not a schema change forcing an
  email onto every user; see §11.4.
- Existing auth: agent Bearer credentials (pairing) + human session cookies, enforced at
  exactly one point — the `/api/*` middleware at `src/server/app.ts:82`. Roles are
  `user`/`admin`; status is `pending`/`active`/`disabled`. Billing must not touch either.
- Traffic shape: agent sessions heartbeat on a timer (`SESSION_TTL_MS` default 120 s), so
  cost scales with *concurrent agent sessions*, not with humans or with page views.
- Two blockers already visible in the code that must be fixed before accepting payments:
  `app.use('*', cors())` is open to all origins (`src/server/app.ts:68`) and the session
  cookie is deliberately not `Secure` (`src/server/app.ts:42`).
- `package.json` says `"license": "MIT"`. Anyone may self-host. The paid product is the
  hosted instance and its uptime, not the code. **[REC]** Decide consciously whether to
  keep MIT before launch; it caps pricing power but is also the distribution channel.

---

# 1. Monetization model

## 1.1 Proposed three tiers

Pricing unit is **the account (one owner + their projects and members)**, not per seat.
Per-seat pricing at €1–€25 creates proration, mid-cycle invoices and support load that
this business cannot absorb.

| | **Free** | **Solo — €1/mo** (see §1.3) | **Team — €5/mo** | **Studio — €25/mo** |
| --- | --- | --- | --- | --- |
| Intended customer | Evaluator, OSS project, someone testing whether the idea helps at all | Single developer running 1–3 agents on their own machine | Small team or heavy solo user with several repos and machines | Agencies, small studios, teams running large agent fleets; the "stop thinking about limits" tier |
| Members | 1 | 1 | 5 | 25 |
| Projects | 1 | 3 | 25 | 250 (soft) |
| Concurrent agent sessions | 2 | 5 | 25 | 150 |
| Active claims | 20 | 100 | 1,000 | 10,000 |
| API requests / day | 5,000 | 25,000 | 150,000 | 1,000,000 |
| History retention | 7 days | 30 days | 180 days | 730 days |
| Bandwidth / month | 2 GB | 10 GB | 50 GB | 250 GB |
| Support | Docs only | Email, best effort | Email, 3 business days | Email, 1 business day |
| Features | Core protocol, dashboard | + private projects, credential management | + project roles, invitations, longer history, CSV/JSON export | + audit log export, priority pairing limits, named contact, early access |
| Overages | No — hard stop | No | No | No |
| Infra cost exposure at 100 % use | ~€0.02/mo | ~€0.05/mo | ~€0.30/mo | ~€2.00/mo (**[ASSUMPTION]**, see §2.4) |
| Target contribution before support & fixed costs | n/a (cost of acquisition) | ~45 % | ~85 % | ~88 % |

**[ASSUMPTION — all numeric limits in this table are provisional.]** 150 concurrent
sessions, 1M requests/day, 250 GB, 730-day retention and the per-tier cost exposures are
*designed* numbers, not measured ones. None of the §2.6 measurements exist yet. Treat every
limit here as a **provisional safety limit to be recalibrated from measured session,
request, storage and support costs** — and do not publish (or contractually promise) any of
them before the SQLite write path has been load-tested under the real heartbeat and
claim-write pattern. Beta terms should explicitly reserve the right to adjust limits.

**[REC] No overages, ever.** Overages require metering you trust, invoices you did not
plan for, disputes you cannot afford, and — under German consumer law — clear pre-contract
disclosure of a price the customer cannot predict. Hard caps with an upgrade prompt are
cheaper to build, cheaper to explain, and legally quieter.

**[REC] "Effectively unrestricted" is a marketing phrase, not a limit.** The €25 tier
should be described as "limits you will not hit in normal use" and be backed by numeric
caps in the docs plus a fair-use clause. Never publish the word *unlimited*: it is a
promise you cannot bound, and in Germany a headline "unlimited" contradicted by a
throttle is a plausible §5 UWG misleading-advertising problem **[ADVISER]**.

## 1.2 Abuse risks and upgrade incentives per tier

| Tier | Main abuse risk | Mitigation | What pushes the upgrade |
| --- | --- | --- | --- |
| Free | Serial account creation to get N free projects; scraping `/api/projects/:p/state` in a tight loop | Admin approval already exists (`status: 'pending'`); per-account and per-IP rate limits; 7-day retention makes the free tier useless as storage | Second project; second machine; history older than a week |
| €1 | Account sharing between several developers | 1 member, low concurrent-session cap, credential count cap | Third project; a colleague joins |
| €5 | Sharing one account across a whole team; running CI at heartbeat frequency | Member cap, concurrent-session cap, request/day cap | 6th member; retention for quarterly review; export |
| €25 | The "unlimited" reading — someone pointing a fleet or a load generator at it | Numeric caps published; fair-use clause; per-account cost tracking with alerts; manual suspension right (§10) | Nothing above it — this is the ceiling. Upsell is annual billing, not a higher tier |

## 1.3 Is the €1 tier viable? **No, not as a monthly card subscription.**

At €1 with Stripe direct on an EEA consumer card:

- Card fee **1.5 % + €0.25** = €0.265 **[FACT — [Stripe DE pricing](https://stripe.com/de/pricing)]**
- Stripe Billing pay-as-you-go **0.7 %** = €0.007 **[FACT — same source]**
- Total ≈ **€0.272, i.e. 27.2 % of gross**, before VAT, before service cost.

Add VAT once you leave the Kleinunternehmerregelung (§4): net revenue is €1.00 / 1.19 =
**€0.8403**, so fees are **32 %** of what you actually keep. Contribution ≈ **€0.55/month**.

That is not the problem. The problem is everything downstream of the €0.55:

- **One Stripe chargeback costs €20** **[FACT — [Stripe DE pricing](https://stripe.com/de/pricing)]** = 36 months of that customer's margin.
- **One 10-minute support email** at any plausible value of the operator's time wipes out
  roughly a year of that customer's margin.
- **One refund** returns €1.00 to the customer while the €0.265 card fee is not returned
  as a percentage refund on Stripe's standard tier — you are net negative on the customer.
- The €1 tier still generates the same VAT line, the same invoice, the same retention
  obligation, the same dunning emails and the same cancellation flow as the €25 tier.
- Stripe's minimum EUR charge is €0.50 **[FACT — [Stripe currencies](https://docs.stripe.com/currencies)]**,
  so €1 is legal but sits near the floor the whole payments industry is priced against.
- With Paddle it is outright impossible: 5 % + $0.50 = **55 % of a €1 charge**, and Paddle
  explicitly requires custom pricing for products under $10 **[FACT — [Paddle pricing](https://www.paddle.com/pricing)]**.

**[REC] Three ways to keep a €1 price point without a €1 monthly charge:**

1. **Best: €12/year, annual only.** One charge instead of twelve. Fees fall to
   1.5 % × €12 + €0.25 + 0.7 % = €0.51 = **4.3 %**. Contribution ≈ €9.60/year vs €6.60 if
   billed monthly, with 1/12 of the payment events, dunning events and failure modes.
2. **Drop it and ship a free tier instead.** The €1 tier's real job is "let people in
   cheaply". A strict free tier does that with zero payment surface.
3. **Never: prepaid €1 wallet top-ups.** Minimum top-ups that exceed the price the
   customer wanted to pay are the classic dark pattern the Digital Fairness Act is aimed
   at (§5), and stored balances raise e-money questions **[ADVISER]**.

## 1.4 Billing-model comparison

| Model | Complexity to build | Fee efficiency at €1–€5 | Legal load (DE/EU) | Verdict |
| --- | --- | --- | --- | --- |
| **Monthly subscription** | Low | Poor below ~€5 | Standard: §312j, §312k, withdrawal, renewal notices | **Keep for €5 and €25** |
| **Annual billing** | Low (same objects, longer interval) | Excellent — 12× fewer fixed fees | Same, plus §309 Nr. 9 BGB limits (max 2-year term, renewal only into an indefinite contract cancellable within one month) **[FACT — [§309 BGB](https://www.gesetze-im-internet.de/bgb/__309.html)]** | **Add at launch, discount ~2 months** |
| **Prepaid credit packs** | Medium — ledger, expiry rules, partial refunds | Good | Credit expiry is a known consumer-law flashpoint; unused balances are a liability | **No** |
| **Minimum wallet top-ups** | Medium-high | Good | Worst option: forced overpayment, refund duties on residual balance, possible e-money exposure **[ADVISER]** | **No** |
| **Free tier, strict limits** | Low — it is just an entitlement with small numbers | n/a | Low, **but not zero**: no payment contract, but §312(1a)/§327(3) BGB extend consumer-contract rules to "pay with data" contracts unless the data is processed *exclusively* to provide the service or meet legal requirements. This app's username/password-only free account fits that carve-out today — adding analytics, marketing, profiling or nonessential telemetry would flip it (§5.11) **[FACT — [§312 BGB](https://www.gesetze-im-internet.de/bgb/__312.html), [§327 BGB](https://www.gesetze-im-internet.de/bgb/__327.html)]** | **Yes — this replaces the trial** |
| **Time-limited trial** | Medium — trial-end webhooks, conversion notices, reminder emails | n/a | Adds trial-conversion disclosure duties and the highest-risk dark-pattern surface | **Not for MVP** |
| **Usage-based billing** | High — metering you must be able to defend in a dispute | Fine | Price must be predictable pre-contract; disputes over meter readings | **No** |
| **Hybrid subscription + usage credits** | Highest | Fine | All of the above at once | **No** |

**[REC] The simplest sustainable model:**

> **Free tier (strict, no card) → €5/month or €50/year → €25/month or €250/year.**
> No overages, no metered billing, no credits, no trial. A €12/year "Solo" tier is
> optional and costs almost nothing extra to run *because it is annual*.

Rationale: the free tier does the job of the trial with none of its legal machinery; two
paid tiers is the minimum that lets a customer upgrade; annual billing is the only lever
that meaningfully improves unit economics at these price points.

---

# 2. Cost and margin model

## 2.1 Fixed costs

| Item | Estimate | Basis |
| --- | --- | --- |
| Production VPS | **€3.79–€6.80/mo** | Hetzner CX22 (2 vCPU/4 GB/40 GB) €3.79, CX32 (4 vCPU/8 GB/80 GB) €6.80, both with 20 TB traffic included at EU locations **[FACT — [Hetzner](https://www.hetzner.com/pressroom/new-cx-plans/)]** |
| Backups / snapshots | ~€1.40/mo | 20 % of server price **[ASSUMPTION]** |
| Staging (optional) | €3.79/mo | Same CX22 |
| Domain + TLS | ~€1.50/mo | TLS free (Let's Encrypt / tunnel) |
| Email delivery | **€0** to start | Resend free tier: 3,000 emails/month, 100/day, 1 domain; $20/mo for 50,000 **[FACT — [Resend pricing](https://resend.com/pricing)]** |
| Monitoring / logging | €0 | Self-hosted or free tier **[ASSUMPTION]** |
| Off-site backup storage | ~€1/mo | Object storage, DB is small |
| Accounting software or Steuerberater | **€25–€125/mo** | Wide range: DIY EÜR tooling at the low end; adviser for EÜR + USt at the high end **[ASSUMPTION] [ADVISER]** |
| Legal documents (one-off) | €0–€1,500 | Templates vs reviewed documents (§6) |
| **Fixed run-rate** | **≈ €35–€165/mo** | Low end = KleinunternehmerRegelung + templates + DIY books; high end = VAT-registered with an adviser |

## 2.2 Variable costs

| Item | Exposure | Notes |
| --- | --- | --- |
| Compute | Very low | Per request: one JSON parse, one Zod validation, 1–3 SQLite statements. No model calls |
| Database / storage | Low, but **unbounded over time** | `claims` are retained after completion (`status: 'done'`), `bugs` are never pruned; only `events` is capped (`EVENTS_CAP`). Retention limits per tier are a *cost control*, not just a feature |
| Bandwidth | Effectively free at this scale | 20 TB included per server **[FACT — Hetzner]**; the risk is one account, not the aggregate |
| Third-party APIs | **€0** | None |
| AI / model usage | **€0** | None in the codebase |
| Payment fees | 3–30 % of gross | See §2.3 |
| VAT | 19 % of gross, once registered | Not a cost — it is not yours — but it is 19 % of the sticker price you never see **[FACT — §12 UStG]** |
| Refunds | Full amount + non-recovered fixed fee | Card fees on Stripe standard: card refunds themselves are free but the original fee is not returned **[FACT — [Stripe DE pricing](https://stripe.com/de/pricing)]**; verify the exact refund-fee treatment for your account tier |
| Chargebacks | **€20/dispute (Stripe)**, **€16 (PayPal)**, **$15 (Polar)** | **[FACT — [Stripe DE](https://stripe.com/de/pricing), [PayPal DE](https://www.paypal.com/de/webapps/mpp/merchant-fees), [Polar pricing](https://polar.sh/resources/pricing)]** |
| Email | ~€0 | Within free tier until thousands of users |
| Support | The dominant variable cost | **[ASSUMPTION]** 0.1 contacts/user/month at 10 min each |
| Bookkeeping overhead | Grows with transaction count, not revenue | Another argument for annual billing |

## 2.3 Unit economics

Two VAT scenarios, because they are very different businesses:

- **(A) Kleinunternehmer (§19 UStG):** no VAT charged, no VAT remitted. Net = gross.
- **(B) VAT-registered:** German consumer price is VAT-inclusive; net = gross / 1.19.

Payment fees are always calculated on the **gross** amount (the amount the card is charged,
including VAT).

### Scenario A — Kleinunternehmer, Stripe direct, EEA consumer card

| | €1/mo | €5/mo | €25/mo | €50/yr | €250/yr |
| --- | --- | --- | --- | --- | --- |
| Gross customer payment | 1.00 | 5.00 | 25.00 | 50.00 | 250.00 |
| VAT | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| Card fee (1.5 % + €0.25) | −0.265 | −0.325 | −0.625 | −1.00 | −4.00 |
| Stripe Billing (0.7 %) | −0.007 | −0.035 | −0.175 | −0.35 | −1.75 |
| **Total fees** | −0.272 (**27.2 %**) | −0.360 (**7.2 %**) | −0.800 (**3.2 %**) | −1.35 (**2.7 %**) | −5.75 (**2.3 %**) |
| Service cost **[ASSUMPTION]** | −0.05 | −0.15 | −0.60 | −1.80/yr | −7.20/yr |
| **Contribution** | **0.68/mo** | **4.49/mo** | **23.60/mo** | **46.85/yr** | **237.05/yr** |
| Contribution before support & fixed costs | 68 % | 90 % | 94 % | 94 % | 95 % |

### Scenario B — VAT-registered (19 % German VAT), Stripe direct + Stripe Tax

| | €1/mo | €5/mo | €25/mo | €50/yr | €250/yr |
| --- | --- | --- | --- | --- | --- |
| Gross customer payment | 1.00 | 5.00 | 25.00 | 50.00 | 250.00 |
| VAT remitted (19/119) | −0.1597 | −0.7983 | −3.9916 | −7.9832 | −39.9160 |
| **Net revenue** | 0.8403 | 4.2017 | 21.0084 | 42.0168 | 210.0840 |
| Card fee (1.5 % + €0.25) | −0.265 | −0.325 | −0.625 | −1.00 | −4.00 |
| Stripe Billing (0.7 %) | −0.007 | −0.035 | −0.175 | −0.35 | −1.75 |
| Stripe Tax Basic (0.5 %) | −0.005 | −0.025 | −0.125 | −0.25 | −1.25 |
| **Total fees** | −0.277 | −0.385 | −0.925 | −1.60 | −7.00 |
| Fees as % of **net** | **33.0 %** | **9.2 %** | **4.4 %** | **3.8 %** | **3.3 %** |
| Service cost **[ASSUMPTION]** | −0.05 | −0.15 | −0.60 | −1.80/yr | −7.20/yr |
| **Contribution** | **0.51/mo** | **3.67/mo** | **19.48/mo** | **38.62/yr** | **195.88/yr** |
| Contribution before support & fixed costs (on net) | 61 % | 87 % | 93 % | 92 % | 93 % |

**These percentages are not margins.** They exclude support labour, accounting, legal
cost, monitoring, operator time, refund handling, free-tier infrastructure, and provider
reserves/payout delays — and §2.2 identifies support as the *dominant* variable cost. The
support-inclusive view is in §2.3.1; the fixed costs are in §2.4.

### Scenario C — merchant of record (Stripe Managed Payments), for comparison

Managed Payments is **3.5 % of the transaction including taxes, charged in addition to
normal Stripe processing fees**, and Stripe Billing fees still apply for subscriptions
**[FACT — [Managed Payments pricing](https://support.stripe.com/questions/managed-payments-pricing)]**.

| | €1/mo | €5/mo | €25/mo | €250/yr |
| --- | --- | --- | --- | --- |
| Processing (1.5 % + €0.25) | −0.265 | −0.325 | −0.625 | −4.00 |
| Managed Payments (3.5 %) | −0.035 | −0.175 | −0.875 | −8.75 |
| Billing (0.7 %) | −0.007 | −0.035 | −0.175 | −1.75 |
| **Total** | **−0.307 (30.7 %)** | **−0.535 (10.7 %)** | **−1.675 (6.7 %)** | **−14.50 (5.8 %)** |
| vs. Scenario B fees | +0.030 | +0.150 | +0.750 | +7.50 |

**The MOR premium is ≈ 3 % of gross** (3.5 % MOR minus the 0.5 % Stripe Tax you would
otherwise pay). At €2,500/month of revenue that is €75/month ≈ €900/year — roughly what a
Steuerberater costs to handle OSS filings **[ASSUMPTION]**. See §3.4.

### Scenario D — Paddle, for comparison

5 % + $0.50 all-inclusive **[FACT — [Paddle pricing](https://www.paddle.com/pricing)]**
(treating $0.50 ≈ €0.46 **[ASSUMPTION — FX]**):

| | €1 | €5 | €25 | €250/yr |
| --- | --- | --- | --- | --- |
| Fee | −0.51 (**51 %**) | −0.71 (**14.2 %**) | −1.71 (**6.8 %**) | −12.96 (**5.2 %**) |

Paddle beats Stripe-MOR only above roughly €30 per transaction; below €10 it is not
offered at list price at all.

### 2.3.1 The same numbers with support included

**[ASSUMPTION]** Operator time valued at €50/hour; mean handling time 10 minutes per
contact → **€8.33 per support contact**. Three support intensities, applied to the
Scenario B (VAT-registered) contributions:

| Contacts / account / month | Support cost / account | €5 plan: 3.67 → | €25 plan: 19.48 → |
| --- | --- | --- | --- |
| 0.05 (docs are good, users are developers) | −€0.42 | **€3.25** (77 %) | **€19.06** (91 %) |
| 0.10 (the §2.2 base assumption) | −€0.83 | **€2.84** (68 %) | **€18.65** (89 %) |
| 0.20 (billing questions, dunning, confused agents) | −€1.67 | **€2.00** (48 %) | **€17.81** (85 %) |

Two readings: (1) the €25 tier is robust to support load; (2) the €5 tier degrades fast —
at 0.2 contacts/month more than half its contribution is gone, and **a single 10-minute
contact in a month (€8.33) exceeds that month's entire €5-plan contribution (€3.67)**.
A hypothetical €1 monthly tier (€0.51) is under water at *any* nonzero support rate.
This is why measurement §2.6(7) — contacts per 100 users per month — gates final pricing,
and why docs-first support and machine-readable 402 errors (§10) are unit-economics
features, not niceties.

## 2.4 Break-even customer counts

Contribution figures from Scenario B (the pessimistic, VAT-registered case).

| Fixed cost / month | Break-even on €5 subs | on €25 subs | on €50/yr (≈ €3.22/mo) | on €250/yr (≈ €16.32/mo) |
| --- | --- | --- | --- | --- |
| **€35** (lean, Kleinunternehmer, templates) | 10 | 2 | 11 | 3 |
| **€90** (mid) | 25 | 5 | 28 | 6 |
| **€165** (VAT-registered + adviser + staging) | 45 | 9 | 52 | 11 |

At €0.51 contribution, a **€1 monthly** tier needs **69 / 177 / 324** customers for those
same fixed costs — a support population large enough that support alone exceeds the
revenue. This is the quantitative form of the §1.3 recommendation.

## 2.5 Worst-case exposure from a maxed-out customer

The €25 tier as specified in §1.1:

| Resource | Cap | Worst-case cost | Basis |
| --- | --- | --- | --- |
| Bandwidth | 250 GB/mo | ~€0 | 20 TB included per server **[FACT — Hetzner]**; 80 such customers to exhaust it |
| Requests | 1M/day = 30M/mo | The real constraint | **[ASSUMPTION]** ~2,000 req/s achievable per CX32 for this workload — **must be measured**, see §2.6 |
| Storage | 10,000 active claims + 730-day history | ~2–5 GB/account **[ASSUMPTION]** | 40 GB disk on CX22 holds ~10 such accounts; disk is the first thing to exhaust |
| Concurrent sessions | 150 | Memory + write contention on one SQLite writer | SQLite is a single-writer store; concurrency, not bandwidth, is the ceiling |

**[REC]** Worst case for a single €25 account should be **bounded below €2.50/month
(10 % of gross)**. The caps above are chosen to do that under the assumptions listed —
they are only as good as the measurements in §2.6.

**The uncapped risk is not any single customer — it is disk growth over time.** Claims and
bugs are retained indefinitely today. Retention limits per tier must be *enforced by a
pruning job*, not merely stated in the pricing table.

## 2.6 Measurements required before final pricing

None of §2 is trustworthy until these are collected from the running service:

1. **Bytes out per active agent session-hour** (dominated by `GET /api/projects/:p/state`
   payload size × poll frequency).
2. **Requests per active session-hour** at the default `SESSION_TTL_MS`, including the
   dashboard's polling interval.
3. **Max sustained requests/second on one CX22 and one CX32** before p95 latency degrades
   — with a realistic mix of writes to `claims` and reads of project state.
4. **Concurrent agent sessions supported per server** before SQLite write contention bites.
5. **DB bytes per project-month** at realistic claim/bug volume, and per completed claim.
6. **Ratio of concurrent sessions to paying accounts** — the single most important number
   for whether the tier caps are generous or stingy.
7. **Support contacts per 100 users per month** and mean handling time.
8. **Refund rate and chargeback rate** — after 3 months of real payments, not before.
9. **Churn by tier and billing interval** — decides how hard to push annual.
10. **Free-to-paid conversion** — decides whether the free tier is acquisition or leakage.

---

# 3. Payment-provider comparison

All figures below are from the provider's own current pricing pages, retrieved 2026-07-24.

## 3.1 Comparison table

| | **Stripe (direct)** | **Stripe Managed Payments** | **Paddle** | **Lemon Squeezy** | **Mollie** | **PayPal** | **Polar** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Available to German sole trader | Yes | Yes — GA, Stripe markets it to German businesses **[FACT — [Stripe](https://stripe.com/managed-payments)]** | Yes | See §3.2 | Yes | Yes | Yes |
| Model | **Processor** — you are the seller | **MOR** — Link is merchant of record; statements read "Sold through Link" **[FACT — [docs](https://docs.stripe.com/payments/managed-payments/how-it-works)]** | **MOR** **[FACT]** | MOR | **Processor** — you remain the seller **[UNVERIFIED — Mollie does not claim MOR status; confirm in Mollie's terms]** | **Processor** | **MOR** **[FACT — [Polar](https://polar.sh/resources/pricing)]** |
| Headline price (DE) | Cards EEA **1.5 % + €0.25**; EEA premium 1.9 % + €0.25; UK 2.5 % + €0.25; non-EEA **3.25 % + €0.25**; SEPA DD **€0.35**; Klarna from 2.99 % + €0.35 **[FACT — [Stripe DE](https://stripe.com/de/pricing)]** | **+3.5 %** on top of processing **[FACT]** | **5 % + $0.50**; under $10 requires custom pricing **[FACT]** | 5 % + $0.50 **[UNVERIFIED — page returned 403]** | Cards EU consumer **1.80 % + €0.25**; EEA commercial 2.90 % + €0.25; non-EEA 3.25 % + €0.25; SEPA DD **€0.35**; iDEAL €0.42 **[FACT — [Mollie DE](https://www.mollie.com/de/pricing)]** | Domestic **2.99 % + €0.39**; +1.29 % UK, +1.99 % rest of world; micropayments 4.99 % + €0.09 on approval **[FACT — [PayPal DE](https://www.paypal.com/de/webapps/mpp/merchant-fees)]** | Starter **5 % + 50¢** free; Pro 3.8 % + 40¢ at $20/mo; +1.5 % international cards; payout 0.25 % + $0.25 + $2/mo **[FACT]** |
| Subscription engine | Stripe Billing **0.7 %** PAYG **[FACT]** | Billing fees still apply **[FACT]** | Included | Included | Recurring included, no extra fee **[FACT — Mollie DE]** | Included | Included |
| SEPA Direct Debit | Yes, €0.35 | Not listed among Managed Payments methods **[FACT — docs list cards, wallets, Klarna, UPI, Pix, Bancontact]** | Yes (buyer-facing) | Yes | Yes, €0.35 | No | Via Stripe rails |
| VAT calculation | Stripe Tax: **0.5 %/transaction** (no-code) or €0.45/API call **[FACT]** | Included in the 3.5 % | Included | Included | **Not provided — your job** | **Not provided — your job** | Included |
| VAT **registration + filing + remittance** | **Yours.** Stripe Tax monitors thresholds and can register on your behalf as a paid option, but the obligation stays with you **[FACT — [Stripe Tax docs](https://docs.stripe.com/tax)]** | **Stripe's**, in 80+ countries **[FACT]** | **Paddle's** **[FACT]** | Provider's | **Yours** | **Yours** | **Polar's** — holds EU OSS (Ireland), UK and US registrations **[FACT]** |
| Invoices to customers | Stripe Invoicing (0.4 %/paid invoice) or your own | **Stripe sends all invoices/receipts; not customisable via your email settings** **[FACT]** | Paddle-branded | Provider-branded | Mollie Invoicing available | Basic | Polar-branded |
| Subscription lifecycle | Full, mature | Full; customers manage subs on the Link site | Full | Full | Solid, less rich | Adequate, weakest API | Full |
| Refunds / chargebacks | You handle; **€20/dispute** | **Stripe manages disputes for "eligible card disputes"** — but Stripe states standard dispute fees "may apply depending on your setup and dispute outcomes"; the MOR does **not** simply absorb chargeback liability **[FACT — [MP pricing FAQ](https://support.stripe.com/questions/managed-payments-pricing)]**; refunds within 60 days | Paddle handles | Provider handles | You handle | You handle; €16 | Polar handles; **$15/dispute regardless of outcome** |
| Customer portal | Hosted, no-code, 47+ languages incl. German; update payment method, cancel, switch up to 10 products, view/pay invoices **[FACT — [docs](https://docs.stripe.com/customer-management)]** | Link-hosted portal | Yes | Yes | Limited | Limited | Yes |
| Webhooks | Best in class, documented idempotency guidance **[FACT — [docs](https://docs.stripe.com/billing/subscriptions/webhooks)]** | Same infrastructure | Good | Good | Good | Weakest | Good |
| Suitability for **€1** | Poor (27 %) but *possible* — EUR minimum is €0.50 **[FACT]** | Poor (31 %) | **Not offered** at list price | Poor | Poor (~30 %) | Poor (~42 %; micropayments rate helps if approved) | Poor |
| Suitability for **€5** | **Best (7.2 %)** | 10.7 % | 14.2 % | ~14 % | 8.0 % | 15.6 % | ~14 % (Starter) |
| Suitability for **€25** | **Best (3.2 %)** | 6.7 % | 6.8 % | ~6.8 % | 3.8 % | 4.6 % | ~7 % |
| Accounting exports | Excellent (Reporting, Sigma, CSV) | Same | Good; single MOR payout is simple to book | Good | Good | Adequate | Good |
| EU consumer-law support | You build checkout consent, §312k button, withdrawal text yourself | Stripe's checkout + Link portal; **verify the German cancellation route satisfies §312k** **[ADVISER]** | Paddle contracts with the buyer, carries much of it | Same | You build it | You build it | Polar contracts with the buyer |
| GDPR posture | Stripe DPA is part of the SSA; Irish main establishment (STC/SPEL); SCC modules 1 & 2; certified under EU-US DPF **[FACT — [Stripe DPA](https://stripe.com/legal/dpa)]** | Same | DPA where Paddle acts as processor for your data; Paddle is controller for buyer data it collects as MOR **[FACT — [Paddle DPA](https://www.paddle.com/legal/data-processing-addendum), [Paddle GDPR](https://www.paddle.com/legal/gdpr)]** | Stripe group | EU (NL) processor | Controller | MOR |
| Integration effort | Medium (Checkout + portal + webhooks ≈ 300–500 LOC) | Low-medium | Low-medium | Low | Medium | Medium | Low |
| Lock-in | Low — card data is portable on request; objects are yours | Medium — customer relationship sits with Link | **High** — Paddle owns the customer contract; migrating means re-collecting payment consent | High | Low | Low | Medium-high |
| Non-EU customers | You must handle US sales tax, UK VAT, etc. yourself once thresholds hit **[ADVISER]** | Stripe files in 80+ countries | Paddle handles | Provider handles | **Yours** | **Yours** | Polar handles |

## 3.2 Lemon Squeezy — current status

Lemon Squeezy was acquired by Stripe in July 2024 **[FACT — [Lemon Squeezy blog](https://www.lemonsqueezy.com/blog/stripe-acquires-lemon-squeezy)]**.
Its capabilities are being folded into **Stripe Managed Payments**, which entered public
preview in February 2026 **[FACT — [Stripe changelog](https://docs.stripe.com/changelog/clover/2026-02-25/managed-payments)]**
and is now generally available **[FACT — [Stripe](https://stripe.com/managed-payments)]**.
Lemon Squeezy's own 2026 status page and pricing page returned HTTP 403 to automated
retrieval, so the exact signup status is **[UNVERIFIED]**.

**[REC] Do not start a new integration on Lemon Squeezy in 2026.** Whatever its current
signup status, the roadmap points at Stripe Managed Payments; integrating against the
predecessor buys a migration.

## 3.3 Recommendations

**1. The provider choice depends on the launch mode (§5.10) — Managed Payments is not an
unconditional recommendation.**

Stripe Managed Payments moves VAT registration, OSS filing, remittance in 80+ countries,
customer invoices and dispute management off the operator, at a premium of ≈ 3 % of gross.
That is genuinely attractive — **for a broad B2C or international launch**. But
recommending it as the universal launch provider is premature, for three reasons:

- **The German accounting treatment is unresolved.** The MOR fee is invoiced by **Sold
  through Link, LLC** (the former Lemon Squeezy entity, a US Delaware LLC), while
  processing fees come from Stripe's local entity; the seller receives three monthly
  documents including a **self-billed tax invoice** for the funds transferred
  **[FACT — [which invoices](https://support.stripe.com/questions/which-invoices-will-i-receive-for-managed-payments-transactions), [Sold through Link entity](https://support.stripe.com/questions/why-is-sold-through-link-llc-the-legal-entity-on-my-invoice-for-stripe-managed-payments-fees)]**.
  Stripe nowhere documents the VAT characterisation of *your* supply to that US entity.
  Whether that supply counts toward the §19 UStG thresholds, whether the self-billed
  invoice satisfies German bookkeeping/GoBD, and whether Stripe's EU-entity fees trigger a
  §13b reverse charge the Kleinunternehmer must pay without input-VAT deduction are all
  **open [ADVISER] questions** — get written clarification from a Steuerberater **before
  accepting money**, not after. §13.8 Q3 covers this; the point is that it must be
  *answered*, not merely asked.
- **Dispute liability is not simply absorbed.** Stripe states standard dispute fees "may
  apply depending on your setup and dispute outcomes"; coverage is "eligible card
  disputes" **[FACT — [MP pricing](https://support.stripe.com/questions/managed-payments-pricing)]**.
- **No SEPA Direct Debit** under Managed Payments (cards, wallets, Klarna one-time, plus
  regional methods — no bank debits) **[FACT — [how it works](https://docs.stripe.com/payments/managed-payments/how-it-works)]** —
  a real conversion consideration for German recurring payments. Also: all customer
  invoices/receipts are sent by Stripe and are not customisable, the customer sees "Link"
  as the merchant, and neither the §312k route nor the new §356a withdrawal function is
  provided by Stripe — Stripe's own §312k article treats the button as the merchant's
  problem, and whether those duties formally shift to the MOR as the consumer's contract
  counterparty is unaddressed by Stripe **[ADVISER]**. Build `/kuendigen` and `/widerruf`
  yourself either way (§5.5, §5.6.1).

**[REC] Decision rule:**

- **Germany-only controlled beta (B2B-only or small B2C):** start on **Stripe direct** —
  cheapest, most controllable, SEPA DD available, and while Kleinunternehmer +
  Germany-only there is no cross-border VAT work for an MOR to remove.
- **German/EU B2C at scale, or international launch:** **Managed Payments becomes much
  more attractive** — but only after the Steuerberater has confirmed in writing how MOR
  payouts and self-billing are booked.

**2. Best provider if maximum control matters: Stripe direct (Checkout + Billing + Tax +
Customer Portal), with Mollie as the European alternative.**

Cheapest at every price point in the range (7.2 % at €5, 3.2 % at €25), best webhooks,
best portal, best exports. The price of that control is that *you* are the seller: you
register for OSS, you file, you issue compliant invoices, you defend disputes, you handle
US/UK thresholds. Mollie is a credible EU-domiciled alternative (1.80 % + €0.25 on EU
consumer cards, no monthly fee, recurring included) but provides no tax engine at all, so
it increases your compliance work relative to Stripe.

**3. Is a merchant of record worth the higher fee here? Yes — once cross-border sales
exist. For a Germany-only Kleinunternehmer beta it removes little.**

While the business is Germany-only and under the §19 UStG thresholds, there is no OSS, no
foreign VAT and no per-country determination for an MOR to take away — the premium buys
mostly invoicing and dispute handling. The calculus below applies from the moment EU/
international sales open (Stage 4+):

The MOR premium (≈ 3 % of gross) is worth paying while revenue is small, because the work
it replaces is *fixed*, not proportional: OSS registration, quarterly OSS returns, VAT
determination per customer country, invoice compliance, and the tail risk of getting any
of it wrong. At €500/month revenue the premium is €15/month against an adviser cost that
would not fall below ~€50–125/month **[ASSUMPTION] [ADVISER]**. The economics flip somewhere
around **€25,000–€50,000/year of revenue** — at which point the operator is also large
enough to justify an adviser anyway. Two additional considerations specific to this
project push toward MOR: the operator is a single person (compliance work competes
directly with product work), and the tier prices are low enough that a single compliance
mistake costs more than a year of MOR fees.

**Counter-argument worth weighing:** MOR means the customer's contract is with the
provider, not with you. That complicates future migration, complicates B2B invoicing for
customers who want *your* company on the invoice, and puts a third party's brand on the
statement line. If the plan is to sell to companies rather than individuals, revisit this.

---

# 4. German legal and business requirements

Everything in this section is **[ADVISER]**-flagged as a whole. Primary sources are cited
so the adviser conversation starts from the statute rather than from a blog.

## 4.1 Gewerbe registration

- Anyone operating a trade in Germany must notify it under **§14 GewO** **[FACT — [§14 GewO](https://www.gesetze-im-internet.de/gewo/__14.html)]**.
  Notification goes to the local Gewerbeamt, costs roughly €15–€65 depending on the
  municipality **[ASSUMPTION]**, and is filed *when the activity starts* — including a
  paid beta with a handful of friends, if money changes hands.
- **When is it required?** Operating a paid hosted service for a fee, with intent to
  profit, sustained over time, is a classic Gewerbe. Free private use among friends with
  no payment is not.
- **Freiberuflich instead?** A self-employed developer can sometimes qualify as
  *ingenieurähnlich* under §18 EStG and avoid both Gewerbeanmeldung and Gewerbesteuer.
  The IHKs describe this boundary as regularly disputed in practice **[FACT — [IHK Bodensee-Oberschwaben](https://www.ihk.de/bodensee-oberschwaben/recht/gesetzliche-vorgaben-fuers-gewerb-/gewerbe-industrie-freier-beruf/abgrenzung-gewerbebetrieb-freier-beruf-1937606)]**.
  **Selling standardised access to a hosted product to anonymous customers looks
  commercial rather than freelance.** **[ADVISER — this is the single most consequential
  classification question; get it answered before the first invoice.]**

## 4.2 Business form

**[REC] Einzelunternehmen (sole trader) for stages 1–3.** No minimum capital, no notary,
no Handelsregister, simplest accounting. The trade-off is unlimited personal liability —
acceptable for a coordination service that stores work metadata, less acceptable once
customer data volume or contract values grow. A **UG (haftungsbeschränkt)** (from €1
capital, but notary + Handelsregister + double-entry bookkeeping + corporate returns) is
the usual next step; **[REC]** defer it until revenue justifies the ~€1,000+/year of extra
administration **[ASSUMPTION]**.

## 4.3 Tax registration

- File the **Fragebogen zur steuerlichen Erfassung** with the Finanzamt via ELSTER after
  Gewerbeanmeldung. This is where the Kleinunternehmer election is made and where a
  Steuernummer is issued.
- A **USt-IdNr.** must be requested separately from the BZSt. It is needed for EU B2B
  reverse-charge invoicing and for the Zusammenfassende Meldung (§4.9).

## 4.4 Income tax and trade tax

- Profit is taxed as income (Einkommensteuer) at the operator's personal rate, plus
  Solidaritätszuschlag where applicable.
- **Gewerbesteuer:** natural persons and partnerships get a **€24,500 allowance**, and the
  Steuermesszahl is **3.5 %** **[FACT — [§11 GewStG](https://www.gesetze-im-internet.de/gewstg/__11.html)]**,
  multiplied by the municipal Hebesatz. Below €24,500 of trade profit there is no trade
  tax, which comfortably covers stages 1–3 of the rollout.
- Profit determination will be **EÜR** (cash-basis income statement, Anlage EÜR) for a
  small sole trader **[ADVISER]**.

## 4.5 Kleinunternehmerregelung (§19 UStG)

**[FACT]** Current thresholds (rewritten effective 2025):

- Prior calendar year total turnover **≤ €25,000**, and
- Current calendar year **≤ €100,000**.
- Domestic turnover is **tax-exempt** under §19(1) UStG (a change from the previous "VAT
  not levied" construction).
- The €100,000 limit is a **hard, mid-year cut-off**: the transaction that breaks it is
  already taxable, and standard taxation applies from that point on.
- Source: **[BMF letter of 18 March 2025 on §19/§19a UStG](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/Umsatzsteuer-Anwendungserlass/2025-03-18-sonderregelung-kleinunternehmer.pdf?__blob=publicationFile&v=4)**,
  **[§19 UStG](https://www.gesetze-im-internet.de/ustg_1980/__19.html)**,
  **[IHK Stuttgart](https://www.ihk.de/stuttgart/fuer-unternehmen/recht-und-steuern/steuerrecht/umsatzsteuer-national/kleinunternehmerregelung-in-der-umsatzsteuer-1843632)**.

**Is it useful here? Yes, decisively, for stages 1–3.**

- At €5 and €25 the operator keeps the full sticker price instead of 84 % of it — a **19 %
  revenue uplift** while under €25,000/year, which is exactly the range where the business
  is fragile.
- No VAT returns, no VAT ID needed for domestic sales, far less bookkeeping.
- Consumers do not care: they see a total price either way (§5.2).
- **Costs:** no input-VAT deduction (irrelevant — the cost base is a €7 VPS), and the
  price must **rise 19 % or the margin must fall 19 %** the day the threshold is crossed.
  **[REC] Price the tiers as VAT-inclusive totals from day one** (€5 and €25 are the
  final prices whether or not VAT is inside them) so that crossing the threshold changes
  the accounting, not the sticker price. **But do not *label* them "inkl. MwSt." while
  Kleinunternehmer** — see §5.2 for why that wording is itself a §5 UWG / §14c UStG risk.
- **Invoices must state the exemption.** Since 2025 the reference to the §19 exemption is a
  mandatory invoice element under **§34a Nr. 5 UStDV**, including on small-value invoices
  (§33 UStDV) **[FACT — [IHK Osnabrück](https://www.ihk.de/osnabrueck/recht-und-fair-play/recht/internetrecht/preisangaben-bei-umsatzsteuer-befreiten-kleinunternehmern-1085390)]**.
  A Kleinunternehmer must **never show a VAT line**; showing it means owing it.
- **EU-Kleinunternehmerregelung (§19a UStG)**, new since 1 Jan 2025, extends an exemption
  to other member states if EU-wide turnover stays under €100,000 in both the previous and
  current year, subject to each member state's own national small-business rules
  **[FACT — BMF letter above]**. **[ADVISER]** — whether to use §19a or OSS for EU
  consumers is a real decision, not a formality.

## 4.6 VAT treatment by customer type

| Customer | Place of supply | Treatment |
| --- | --- | --- |
| **German consumer** | Germany | 19 % German VAT (§12 UStG), or exempt under §19 while Kleinunternehmer **[FACT]** |
| **EU consumer** | The consumer's country — electronically supplied services are taxed where the customer resides **[FACT — [§3a Abs. 5 UStG](https://www.gesetze-im-internet.de/ustg_1980/__3a.html)]** | *Unless* total cross-border B2C supplies stayed **≤ €10,000** in the previous calendar year, in which case they may be treated as domestic **[FACT — §3a Abs. 5 Satz 3 UStG]**. The €10,000 threshold covers goods and electronic services combined **[FACT — [IHK Rhein-Neckar](https://www.ihk.de/rhein-neckar/recht/steuerrecht/e-commerce-one-stop-shop-verfahren-6844666)]**. Above it: register for OSS or register in each country. Waiving the threshold voluntarily binds you for two years **[FACT — §3a Abs. 5 Satz 4–5]** |
| **EU business with valid VAT ID** | The customer's country **[FACT — §3a Abs. 2 UStG]** | **Reverse charge** — no German VAT, invoice must say so and carry both VAT IDs. **Must be reported in the Zusammenfassende Meldung** (§4.9) |
| **Non-EU customer** | Outside the scope of EU VAT | No German VAT, but other countries have their own thresholds (UK VAT, Swiss VAT, US state sales tax, Australian GST). **[ADVISER]** — this is precisely what an MOR removes |

## 4.7 One Stop Shop (OSS)

- Registration is with the **BZSt** **[FACT — [BZSt OSS](https://www.bzst.de/DE/Unternehmen/Umsatzsteuer/One-Stop-Shop_EU/one_stop_shop_eu_node.html)]**.
- If the €10,000 threshold is exceeded during a quarter, you can register for OSS by the
  10th day of the following month **[FACT — IHK Rhein-Neckar]**.
- OSS lets you declare all EU B2C VAT in one quarterly return instead of registering in
  each member state. It covers **B2C only** — B2B reverse-charge sales are not in OSS.
- **[REC]** With Stripe Managed Payments or Paddle as MOR, OSS is the provider's problem,
  not yours. This is the single biggest operational reason to choose an MOR.

## 4.8 Invoices

**[FACT]** Mandatory content per **§14 UStG**: full name and address of supplier and
customer, Steuernummer or USt-IdNr., invoice date, sequential invoice number, quantity and
description of the supply, date of supply, consideration broken down by tax rate and
exemption, tax rate and amount, and any required notes (reverse charge, §19 exemption)
**[FACT — [IHK Stuttgart](https://www.ihk.de/stuttgart/fuer-unternehmen/recht-und-steuern/steuerrecht/umsatzsteuer-national/neue-pflichtangaben-fuer-rechnungen-684834)]**.

- **Kleinbetragsrechnungen up to €250 gross** have reduced requirements (§33 UStDV) — which
  covers every invoice this business will issue at €1/€5/€25 monthly and at €50/year;
  €250/year sits exactly on the boundary **[FACT]**.
- **E-invoicing (B2B, domestic):** since **1 Jan 2025** German businesses must be able to
  *receive* structured e-invoices. Paper/PDF remain permitted transitionally through
  **2026**; in **2027** only for businesses with prior-year turnover up to **€800,000**;
  from **2028** structured e-invoices are mandatory. Small-value invoices (≤ €250) and
  Kleinunternehmer invoices are exempt from the issuing obligation
  **[FACT — [IHK Stuttgart](https://www.ihk.de/stuttgart/fuer-unternehmen/recht-und-steuern/steuerrecht/steuermeldungen/e-rechnungen-5864496)]**.
  B2C is not affected. **Practical effect for this project: minimal — but a B2B customer
  may still require an e-invoice, so keep the invoice generator replaceable.**

## 4.9 Recurring subscriptions: special reporting?

There is **no special reporting regime for subscriptions as such**. What recurrence does
is multiply the ordinary obligations:

- **Umsatzsteuer-Voranmeldung**: monthly if prior-year VAT exceeded **€9,000**; the tax
  office may waive pre-returns entirely if prior-year VAT was **≤ €2,000**; quarterly
  otherwise; annual return always due **[FACT — [§18 UStG](https://www.gesetze-im-internet.de/ustg_1980/__18.html)]**.
  The suspension of the "new businesses file monthly" rule runs **1 Jan 2021 – 31 Dec 2026**
  **[FACT — [IHK Düsseldorf](https://www.ihk.de/duesseldorf/existenzgruendung/aktuelles/aussetzung-der-pflicht-zur-monatlichen-uebermittlung-voranmeldungen-in-neugruendungsfaellen-4996474)]**
  — **a launch in 2027 may land under the stricter old rule again. [ADVISER]**
- **Zusammenfassende Meldung (§18a UStG):** if you invoice EU businesses under reverse
  charge, a ZM is due to the BZSt electronically by the **25th day after each quarter**;
  annual filing is possible in limited cases (prior-year supplies ≤ €200,000, of which
  intra-EU ≤ €15,000, and released from Voranmeldungen)
  **[FACT — [BZSt ZM](https://www.bzst.de/DE/Unternehmen/Umsatzsteuer/ZusammenfassendeMeldung/zusammenfassendemeldung_node.html), [§18a UStG](https://www.gesetze-im-internet.de/ustg_1980/__18a.html)]**.
  **This obligation is easy to miss and applies even at tiny volumes.**
- **OSS return** quarterly, once registered.
- **Retention:** **Buchungsbelege must be kept 8 years**; books, inventories and annual
  accounts **10 years**; other documents 6 years; the clock starts at year-end and does not
  expire while an assessment period is open **[FACT — [§147 AO](https://www.gesetze-im-internet.de/ao_1977/__147.html)]**.
  GoBD requires records be unalterable, traceable and machine-readable **[ADVISER]**.

## 4.10 MOR vs direct processor — who does what

| Obligation | Selling via **MOR** (Stripe Managed Payments / Paddle / Polar) | Selling **direct** (Stripe / Mollie / PayPal) |
| --- | --- | --- |
| Contract with the end customer | **Provider** (you supply the provider) | **You** |
| VAT determination per customer | Provider | You (Stripe Tax can compute; obligation stays yours **[FACT]**) |
| VAT registration in other countries / OSS | Provider | **You** |
| VAT filing and remittance | Provider | **You** |
| Customer-facing invoices | Provider | **You** |
| German income tax / Gewerbesteuer on your profit | **You** | **You** |
| Gewerbeanmeldung, Finanzamt registration, bookkeeping | **You** | **You** |
| Booking the provider's payout as revenue | **You** — typically one aggregated payout, and **your** supply is to the provider, not to the consumer. Treatment of that supply (and any reverse charge on it) is **[ADVISER]** | **You** — per-transaction |
| Impressum, Datenschutzerklärung, terms for your service | **You** | **You** |
| §312k cancellation button on your website | **[ADVISER]** — likely still you for the service relationship as the consumer experiences it | **You** |
| Chargeback liability | Provider manages disputes, but **not a blanket absorption** — Stripe MP: standard dispute fees may still apply depending on setup and outcome, and coverage is limited to "eligible card disputes" **[FACT — [MP pricing FAQ](https://support.stripe.com/questions/managed-payments-pricing)]**; exact clawback conditions undocumented **[ADVISER]** | **You** |
| Consumer withdrawal rights | Provider's terms, but your service is the subject matter | **You** |

**An MOR does not make you not-a-business.** Registration, income tax, bookkeeping,
Impressum and privacy obligations remain entirely yours.

---

# 5. German and EU consumer law

**[ADVISER] as a whole.** The MVP requirements below are the author's reading of the cited
statutes; the wording of the actual screens must be reviewed.

## 5.1 Pre-contract information

Distance contracts with consumers require the information in **Art. 246a EGBGB** —
identity and contact details, essential characteristics of the service, total price
including taxes, duration, termination conditions, and the withdrawal right —
provided **immediately before the order is placed** **[FACT — [§312j BGB](https://www.gesetze-im-internet.de/bgb/__312j.html)]**.

## 5.2 Price display

Consumer prices must be shown as **Gesamtpreise** — the total actually payable including
all price components (§3 PAngV) **[FACT — [§3 PAngV](https://www.gesetze-im-internet.de/pangv_2022/__3.html)]**.

**While Kleinunternehmer, do NOT label prices "inkl. MwSt.".** IHK guidance says
Kleinunternehmer should drop the "inkl. MwSt." suffix: it is misleading (§5 UWG,
Abmahnung risk — especially toward business buyers expecting input-VAT deduction) and can
even trigger a **§14c Abs. 2 UStG liability to pay the VAT you implied but never charged**
**[FACT — [IHK Osnabrück](https://www.ihk.de/osnabrueck/recht-und-fair-play/recht/internetrecht/preisangaben-bei-umsatzsteuer-befreiten-kleinunternehmern-1085390), [IHK Gera](https://www.ihk.de/gera/recht-und-steuern/aktuelles-rechtundsteuern/preisangaben-als-kleinunternehmer-6323026)]**.
OLG Hamm (19.11.2013 – I-4 U 65/13) held a Kleinunternehmer has no duty to state "inkl.
MwSt." **[FACT — cited via [IT-Recht Kanzlei](https://www.it-recht-kanzlei.de/kleinunternehmer-mehrwertsteuer-umsatzsteuer.html)]**.

**[REC]** Pricing page and checkout while Kleinunternehmer: show the plain total —
**"€5/Monat"** — with a note perceivably close to the price on every page showing prices
(not buried in the AGB), e.g. the IHK Gera formulation: *"Alle Preise sind Endpreise. Es
erfolgt kein Ausweis der Umsatzsteuer aufgrund der Anwendung der Kleinunternehmerregelung
gem. §19 UStG."* The invoice carries the separate §34a Nr. 5 UStDV exemption note (§4.5)
— webshop label and invoice note are **two different obligations with different wording**.
Exact customer-facing wording **[ADVISER]**.

Once VAT-registered (threshold crossed), switch the label to "inkl. MwSt." — the sticker
price stays the same if the tiers were priced VAT-inclusive from day one (§4.5). Offer a
net price only when a valid VAT ID makes the sale B2B.

## 5.3 The order button (Button-Lösung)

**[FACT — §312j BGB]** The order button must be labelled with nothing other than
**"zahlungspflichtig bestellen"** or an equally unambiguous formulation. If it is not, **no
contract comes into existence** — the customer owes nothing and can reclaim payments.

## 5.4 Contract duration and renewal

**[FACT — §309 Nr. 9 BGB]** In standard terms: initial fixed term max **2 years**; tacit
renewal only into an **indefinite** contract terminable with **max one month's notice**;
notice period before the end of the initial term max one month. A monthly rolling
subscription cancellable at period end satisfies this comfortably.

## 5.5 The Kündigungsbutton (§312k BGB)

**[FACT — [§312k BGB](https://www.gesetze-im-internet.de/bgb/__312k.html)]**

- A cancellation button labelled **"Verträge hier kündigen"** (or equally unambiguous),
  clearly legible, with nothing else on it.
- It leads to a confirmation page where the consumer can state the type of cancellation,
  identify themselves and the contract, give the desired termination date, and receive fast
  electronic confirmation.
- A confirmation button labelled **"jetzt kündigen"**.
- The trader must **immediately** send confirmation in text form stating the content, the
  date and time of receipt, and when the contract ends.
- **If these are missing, the consumer may cancel at any time without notice period.**

**[FACT]** The button and confirmation page must be **permanently available, directly and
easily accessible, and reachable without logging in**; the confirmation page must not carry
other offers **[[IHK Darmstadt](https://www.ihk.de/darmstadt/produktmarken/recht-und-fair-play/online-auftritt/kuendigungsbutton-5557048), [Verbraucherzentrale](https://www.verbraucherzentrale.de/vertraege-reklamation/kuendigungsbutton-nicht-gefunden-so-muss-die-onlinekuendigung-aussehen-78472)]**.
Case law cited by the IHK includes LG Köln 29.07.2022 – 33 O 355/22 (cancellation without
login) and BGH 22.05.2025 – I ZR 161/24 on direct reachability and unambiguous labelling
**[UNVERIFIED — case citations taken from the IHK/Verbraucherzentrale summaries, not read
in the original]**.

**This is the requirement most likely to be missed by relying on a provider's portal.**
A Stripe/Link/Paddle portal sits behind an authenticated session. **[REC]** Ship a public
`/kuendigen` page on your own domain that requires no login, collects the identifying
details, records the declaration with a timestamp, and emails the confirmation — then
reconcile it to the provider's cancel API server-side. **[ADVISER]**

## 5.6 Withdrawal right (Widerruf) for digital services

**[FACT — [§356 BGB](https://www.gesetze-im-internet.de/bgb/__356.html)]** The 14-day
withdrawal right lapses early only if the consumer:

1. **expressly consents** to the trader beginning performance before the withdrawal period
   expires, **and**
2. **confirms their knowledge** that this causes the withdrawal right to lapse (on
   complete performance for services; on commencement for digital content), **and**
3. receives the §312f confirmation of the contract.

**[REC] MVP handling:** for a monthly subscription at €5, the cheapest correct answer is
**do not try to extinguish the withdrawal right at all**. Offer the 14-day right,
provision access immediately, and refund on withdrawal pro rata. At these prices the
refund exposure is a few euros; the checkbox architecture, the wording risk and the
support arguments cost more than that.
**[REC]** If immediate provisioning with a waived withdrawal right is desired later, it
needs two separate, unticked, logged checkboxes and reviewed wording. **[ADVISER]**

### 5.6.1 The electronic withdrawal function — Widerrufsbutton (§356a BGB) — **payment-launch blocker**

Since **19 June 2026**, §356a BGB ("Elektronische Widerrufsfunktion bei
Fernabsatzverträgen") requires an electronic withdrawal function for **all** consumer
distance contracts concluded through an online interface — not only financial services
**[FACT — [§356a BGB](https://www.gesetze-im-internet.de/bgb/__356a.html), [Noerr on the
transposition law](https://www.noerr.com/de/insights/umsetzungsgesetz-zum-widerrufsbutton-veroeffentlicht)]**.
It transposes Art. 11a of the Consumer Rights Directive (inserted by Directive (EU)
2023/2673); the German transposition law was published in BGBl. 2026 I Nr. 28 on
5 Feb 2026 **[FACT — Noerr]**.

This is **separate from and additional to** the §312k Kündigungsbutton:

- **Widerruf (§356a):** reverses a *recently concluded* contract during the 14-day
  withdrawal period.
- **Kündigung (§312k):** terminates an *ongoing* subscription, usually at period end.

An existing Kündigungsbutton does **not** satisfy §356a. Guidance says the two functions
may coexist on one site but should be spatially separated, visually distinct and clearly
labelled **[FACT — [ratgeberrecht.eu](https://www.ratgeberrecht.eu/aktuell/der-widerrufsbutton-kommt-zum-19-06-2026/), [Luther](https://www.luther-lawfirm.com/newsroom/blog/detail/widerruf-per-klick-was-unternehmen-beim-neuen-widerrufsbutton-nach-356a-bgb-nf-beachten-muessen)]**.

Requirements **[FACT — §356a BGB]**:

- A function labelled **"Vertrag widerrufen"** (or equally unambiguous), well legible,
  prominently placed, easily accessible, **continuously available during the withdrawal
  period**. Guidance: reachable without login (unless the contract itself ran through the
  account), linked from every page, working on mobile
  **[FACT — [shopbetreiber-blog](https://shopbetreiber-blog.de/ab-19.6.2026-der-widerrufsbutton-kommt)]**.
- A form where the consumer can provide **name, contract identification (e.g. order
  number), and an electronic contact channel** for the receipt. Requiring more (e.g. a
  mandatory reason) is non-compliant.
- A confirmation button labelled **"Widerruf bestätigen"** (or equivalent).
- The trader must **immediately** confirm receipt on a durable medium (email suffices),
  stating at least the content of the declaration plus the **date and time of receipt**.
- Consequence of non-compliance: secondary sources consistently state the withdrawal
  period extends up to **12 months + 14 days** (mirroring the §356(3) cap), plus
  Abmahnung/UWG risk **[UNVERIFIED — the exact statutory cross-reference was not confirmed
  in the primary text; confirm with the adviser]**.

**[REC]** Ship a public no-login **`/widerruf`** page alongside `/kuendigen`, built on the
same pattern (collect identifying details, record the declaration with a timestamp, send
the confirmation email, reconcile to the provider's refund/cancel API server-side). Keep
the two pages, labels and confirmation emails strictly separate. **[ADVISER]** This is a
**payment-launch blocker for German B2C sales**, exactly like §312k. A genuine B2B-only
launch is out of §356a's scope (§5.10).

## 5.7 Dark patterns

- The EU **Digital Fairness Act** is a Commission initiative announced for **Q4 2026** in
  the 2026 work programme, explicitly targeting dark patterns and *"difficulties with the
  cancellation and renewal of digital subscriptions"*
  **[FACT — [European Parliament Legislative Train](https://www.europarl.europa.eu/legislative-train/theme-protecting-our-democracy-upholding-our-values/file-digital-fairness-act)]**.
  Nothing to comply with yet; **[REC]** design as if it already applied — the direction of
  travel is unambiguous and retrofitting is expensive.
- **[FACT]** The EU **ODR platform was discontinued on 20 July 2025** by Regulation (EU)
  2024/3228, and the obligation for online traders to link to it has been removed
  **[[EUR-Lex](https://eur-lex.europa.eu/eli/reg/2024/3228/oj/eng), [European Commission](https://consumer-redress.ec.europa.eu/site-relocation_en)]**.
  **Do not copy an old template that still contains the ODR link.**

## 5.8 Minimum MVP surface for checkout and cancellation

**Screens**

1. Pricing page — total prices with the §5.2 wording (plain totals + §19 UStG note while
   Kleinunternehmer; "inkl. MwSt." only once VAT-registered), what each tier includes, the numeric limits,
   link to fair-use policy.
2. Checkout summary — service, term, total price, renewal interval, cancellation terms,
   withdrawal notice, links to AGB and Datenschutzerklärung, **button "zahlungspflichtig
   bestellen"**.
3. Payment step (provider-hosted).
4. Confirmation page.
5. Account → Billing — current plan, next renewal date and amount, invoices, "cancel"
   entry point.
6. **Public `/kuendigen` page — no login** (§5.5).
7. Cancellation confirmation page showing date/time of the declaration and the end date.
8. **Public `/widerruf` page — no login** (§5.6.1): "Vertrag widerrufen" entry point,
   form for name / contract identification / contact channel, **"Widerruf bestätigen"**
   confirmation button, kept visually and spatially separate from `/kuendigen`.
9. Legal pages: Impressum, Datenschutzerklärung, AGB, Widerrufsbelehrung + model form.

**Checkboxes / consents**

- AGB and Datenschutzerklärung acknowledgement (unticked, logged with timestamp).
- Optional withdrawal-waiver consent **only** if §5.6's waiver path is chosen — two
  separate unticked boxes, each logged.

**Emails** (all in text form, all archived)

- Order confirmation with the §312f contract details.
- Invoice / receipt per billing period.
- **Cancellation confirmation** — mandatory content per §312k.
- **Withdrawal receipt confirmation** — immediate, durable medium, content of the
  declaration + date and time of receipt, per §356a.
- Payment-failure notice, then dunning reminders.
- Price-change notice — **[REC]** at least 30 days ahead, with an explicit right to cancel
  before it takes effect **[ADVISER]**.
- Renewal reminder for annual plans **[REC]**.

**Records to retain**

- Which document versions the customer accepted, when, and from which IP.
- The exact price, term and tier shown at checkout.
- All cancellation declarations with timestamps.
- All invoices (8-year retention, §4.9).

## 5.9 Failed payments, dunning, suspension

**[REC]** Legally quiet defaults: retry per provider schedule; email at each failure; a
**7-day grace period** with full access; then downgrade to **read-only**, not deletion;
suspend paid features after 14 days; never delete customer data as a dunning measure.
Cancellation by the customer must always be possible during dunning. Full state machine in
§9.

## 5.10 B2C or B2B-only? — the launch-mode decision this document previously skipped

A **consumer** acts predominantly outside their trade or independent professional
activity (§13 BGB); an **Unternehmer** acts within it (§14 BGB). A developer buying this
service *for their work* is an Unternehmer. The natural audience of this product —
professional developers, teams, agencies — is mostly B2B, yet most of §5 assumes B2C
availability. That assumption is a choice, and it is expensive: the §312j order button,
§312k Kündigungsbutton, the withdrawal right, the new §356a Widerrufsbutton, the
Widerrufsbelehrung and the §§327ff digital-products regime are all **B2C-only**.

**Three launch modes to decide between explicitly:**

1. **Invite-only, no payment** (= Stage 1). No consumer-contract surface at all beyond
   Impressum + Datenschutzerklärung.
2. **Verified B2B-only paid beta.** Avoids the entire button/withdrawal surface — *if the
   restriction is done properly*.
3. **Public B2C/B2C+B2B launch.** The full §5 surface applies.

**What a defensible B2B-only restriction requires.** A mere AGB clause ("Verkauf nur an
Unternehmer") is **insufficient** — courts reject AGB-only restrictions. Per OLG Hamm
(16.11.2016 – 12 U 52/16), the limitation must be clear and transparent and the exclusion
of consumer contracts must be "in erheblichem Maße sichergestellt" (substantially
ensured) **[FACT — [ra-plutte.de case summary](https://www.ra-plutte.de/onlineshop-beschraenkung-b2b-kunden/), [CMS](https://cms.law/de/deu/legal-updates/B2B-Online-Shops-muessen-Verbraucher-innen-aktiv-ausschliessen)]**.
The defensible package:

- Prominent, graphically emphasised B2B-only notices on every relevant page — not
  below-the-fold fine print.
- A **separate mandatory checkbox at checkout** confirming Unternehmereigenschaft,
  distinct from AGB acceptance, logged with timestamp.
- A **mandatory company/business-name field**.
- Plausibility checks: real-time VAT-ID validation is permitted but supplementary only —
  not every Unternehmer has a USt-IdNr. (Kleinunternehmer customers, for example).
- **Consistency**: marketing copy addressed to hobbyists/private users undermines the
  restriction.

**[REC]** For the first *paid* beta, seriously consider mode 2. It removes `/kuendigen`,
`/widerruf`, the Widerrufsbelehrung and the §§327ff duties from the launch-blocking path,
and the invited-beta audience is professional anyway. The cost: hobbyist and OSS users
can only be served on the free tier (fine — the free tier takes no payment and stays out
of scope), and the B2C surface must still be built before any *public* consumer launch.
Implementation of the restriction is itself **[ADVISER]** — there is no uniform case law
on the minimum measures.

## 5.11 Further B2C obligations: §§327ff BGB and the BFSG

If (or when) selling to consumers, the digital-products regime adds duties this document
previously omitted — relevant because the app stores project-coordination data created by
users and their agents:

- **Updates (§327f BGB):** during the whole provision period of a continuously supplied
  digital product, the trader must provide the updates — **including security updates** —
  needed to keep the product in conformity, and inform the consumer about them
  **[FACT — [§327f BGB](https://www.gesetze-im-internet.de/bgb/__327f.html)]**.
- **Changes to the product (§327r BGB):** changes beyond maintaining conformity are
  allowed only if the contract provides for them with a valid reason, at no extra cost,
  with clear information. If a change more than insignificantly impairs access or use:
  advance notice on a durable medium, and the consumer may **terminate free of charge
  within 30 days** unless the impairment is minor or the unchanged product remains
  available at no extra cost **[FACT — [§327r BGB](https://www.gesetze-im-internet.de/bgb/__327r.html)]**.
  Practical consequence: the AGB need a change clause, and breaking API/limit changes need
  a notice flow — this dovetails with the price-change notice in §5.8.
- **Content return after termination (§327p BGB):** on request, the trader must provide
  the consumer's provided or created non-personal content **free of charge, in a common,
  machine-readable format** (with narrow exceptions: useless outside the product's
  context, relates only to usage, inseparably aggregated, jointly generated with others
  still using it) **[FACT — [§327p BGB](https://www.gesetze-im-internet.de/bgb/__327p.html)]**.
  The CSV/JSON export already planned for the Team tier is most of this; it must be
  available to a departing consumer regardless of tier.
- **Accessibility (BFSG):** the BFSG covers consumer e-commerce services since
  28 June 2025, but **§3(3) BFSG exempts Kleinstunternehmen providing services** — fewer
  than 10 employees and ≤ €2 M annual turnover or balance-sheet total (§2 Nr. 17 BFSG)
  **[FACT — [§3 BFSG](https://www.gesetze-im-internet.de/bfsg/__3.html), [§2 BFSG](https://www.gesetze-im-internet.de/bfsg/__2.html)]**.
  A one-person operation qualifies for the exemption, so this is **not a launch blocker**
  — but the market-surveillance authority may ask for evidence of size, and the exemption
  must be **reassessed if the company grows** past either threshold.

None of §5.11 applies to a properly restricted B2B-only offering (§5.10), and none of it
applies to the free tier while it stays within the §312(1a) S.2 data carve-out (§1.4).

---

# 6. Required legal documents

| Document | Why | Must contain | Private beta / invited friends | Public launch | Template or lawyer |
| --- | --- | --- | --- | --- | --- |
| **Impressum** | **§5 DDG** (replaced §5 TMG on 14 May 2024); fines up to €50,000 under §33(2) DDG **[FACT — [§5 DDG](https://www.gesetze-im-internet.de/ddg/__5.html), [IHK Chemnitz](https://www.ihk.de/chemnitz/recht-und-steuern/rechtsinformationen/internetrecht/pflichtangaben-im-internet-die-impressumspflicht-4401580)]** | Name, address, email + a second fast contact route, USt-IdNr. if held, legal form/representatives for entities | **Yes** — required for any business-like digital service, even before payment | Yes | **Template is fine**; IHK publishes checklists |
| **Datenschutzerklärung** | Arts. 12–14 GDPR | Controller identity, purposes, legal bases, recipients/subprocessors, transfers, retention, data-subject rights, complaint right | **Yes** — you already store users, credentials and repo metadata | Yes (extended for billing, §7) | Template acceptable; **review recommended once billing and a US processor are added** |
| **AGB / Terms of service** | Not strictly mandatory, but the only way to set service scope, fair use, availability, liability and termination | Service description, tier limits, fair use, availability expectations (avoid an SLA you cannot meet), liability limits, term and termination, changes, applicable law | Recommended (a short beta agreement) | **Yes** | **Lawyer review recommended** — liability and limitation clauses fail most often in German AGB review |
| **Subscription & cancellation terms** | §309 Nr. 9 BGB, §312k BGB | Term, renewal, notice, cancellation routes, effect of cancellation, data after end | Only if payment is taken | **Yes** | **Lawyer** |
| **Widerrufsbelehrung** | §§355, 356 BGB | 14-day period, how to exercise, consequences, the digital-services rules of §5.6 | Only if consumers pay | **Yes** | **Use the statutory Muster-Widerrufsbelehrung**, then have it reviewed |
| **Muster-Widerrufsformular** | Annex to Art. 246a EGBGB | Statutory model form | Only if consumers pay | **Yes** | Statutory template — use verbatim |
| **Widerrufsbutton page (`/widerruf`)** | **§356a BGB** (since 19 June 2026, §5.6.1) | "Vertrag widerrufen" function, form (name, contract ID, contact channel), "Widerruf bestätigen" button, immediate receipt confirmation with date/time | Only if consumers pay | **Yes (B2C)** | Build + **lawyer review** — new law, no settled case law yet |
| **B2B-only restriction package** | Only if launch mode 2 of §5.10 is chosen | Prominent notices, checkout confirmation checkbox, mandatory company field, plausibility checks | If paid beta is B2B-only | n/a (superseded by B2C docs at public launch) | **Lawyer review** — AGB clause alone fails (OLG Hamm 12 U 52/16) |
| **AVV / DPA with your customers** | Art. 28 GDPR, if customers' data in the service includes *their* end-users' personal data | Standard Art. 28 content | Probably not | **Likely yes for B2B** | Template + review |
| **Subprocessor list** | Art. 28(2)/(4), transparency | Hoster, payment provider, email provider, monitoring | Yes (short) | Yes | Self-maintained |
| **Cookie information** | **§25 TDDDG** — consent for non-essential storage | What is stored, purpose, duration | Yes | Yes | **Currently trivial: the app sets one httpOnly session cookie, which is strictly necessary → no consent banner needed.** Re-check the moment analytics or a provider script is embedded |
| **Pricing & fair-use policy** | Makes the numeric limits contractual and enforceable; supports §10 | Per-tier numeric limits, what happens on breach, throttle/suspension policy, no "unlimited" claim | Recommended | **Yes** | Template + review |
| **Refund policy** | Sets expectations beyond the statutory withdrawal right | Statutory rights untouched; voluntary refund window; pro-rata rules; what is not refunded | Optional | **Yes** | Template |
| **Security / incident contact** | Good practice; some customers require it | Reporting address, response expectation | Optional | Recommended | Template |

**[REC]** For a private beta with no payments, the honest minimum is **Impressum +
Datenschutzerklärung + a one-page beta notice**. The rest is triggered by taking money.

---

# 7. GDPR and payment data

## 7.1 Roles

- **You are the controller** for account data, billing records, and everything the service
  stores about projects, claims and sessions.
- **Selling direct via Stripe:** Stripe's DPA is part of the Stripe Services Agreement;
  Stripe's European main establishment is Stripe Technology Company Ltd (Ireland), and for
  regulated payment services Stripe entities act as **joint controllers** of your personal
  data; SCC modules 1 (C2C) and 2 (C2P) are incorporated; Stripe is certified under the
  **EU-US Data Privacy Framework**
  **[FACT — [Stripe DPA](https://stripe.com/legal/dpa), [Stripe DPA FAQs](https://stripe.com/legal/dpa/faqs)]**.
  Note the practical consequence: for the payment transaction itself, Stripe is a
  controller in its own right, not merely your processor.
- **Selling via an MOR:** the buyer contracts with the provider, so the provider is a
  controller for buyer data it collects and needs its own lawful basis to pass data to you;
  Paddle relies on legitimate interest for fulfilment, order processing, fraud prevention
  and support, and restricts your use of that data accordingly
  **[FACT — [Paddle GDPR](https://www.paddle.com/legal/gdpr), [Paddle DPA](https://www.paddle.com/legal/data-processing-addendum)]**.
  **You must not repurpose MOR-supplied buyer data for marketing without a separate basis.**
- **EU-US transfers:** the Commission's EU-US DPF adequacy decision of 10 July 2023 remains
  in force as of 2026; the EDPB refreshed its DPF FAQs to v2.0 in January 2026
  **[FACT — [European Commission adequacy decisions](https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/adequacy-decisions_en), [EDPB DPF FAQ v2.0](https://www.edpb.europa.eu/system/files/2026-01/edpb_dpf_faq-for-businesses_v2_en.pdf)]**.
  **[REC]** Do not treat this as permanent — Schrems-style litigation risk persists. Keep
  the number of US processors low; the hoster is already German (Hetzner).

## 7.2 Minimum billing data model

**[REC] Store the least that still lets you enforce entitlements, answer support questions
and satisfy tax retention:**

| Store | Field | Why |
| --- | --- | --- |
| ✅ | `provider_customer_id`, `provider_subscription_id` | The join key to the provider |
| ✅ | `plan_code`, `status`, `current_period_end`, `cancel_at_period_end` | Entitlement enforcement without an API call |
| ✅ | `billing_email` | Invoices, dunning, §312k confirmation |
| ✅ | `country_code` (2 letters) | VAT determination, reporting |
| ✅ | `vat_id` (B2B only) | Reverse charge |
| ✅ | Invoice **number, date, gross, VAT, currency, provider URL** | §14 UStG + §147 AO retention |
| ✅ | `webhook_event_id`, type, received_at, processed_at | Idempotency + audit |
| ⚠️ | Card **brand + last4 + expiry month/year** | Only if support genuinely needs "which card is failing"; otherwise deep-link to the provider portal |
| ❌ | **PAN, CVC, full expiry, cardholder magstripe data** | Never. Not once, not in a log |
| ❌ | IBAN / full bank details | Not needed; the provider holds them |
| ❌ | Full billing address | **[ADVISER]** — needed on invoices in some cases; if the MOR issues the invoice, you do not need it |
| ❌ | Raw webhook payloads beyond a short window | See §7.3 |

## 7.3 Retention

- **Webhook payloads: [REC] keep the event ID permanently (for idempotency) but the full
  payload only 30–90 days.** After that, keep the derived state and a hash.
- **Billing history:** invoices and payment records fall under **§147 AO — 8 years for
  Buchungsbelege, 10 years for books** **[FACT]**. Retention obligations override the
  erasure right for these specific records (Art. 17(3)(b) GDPR).
- **Account deletion vs. retention:** deleting an account must delete or anonymise
  operational data (sessions, claims, credentials) but **must not** delete tax records.
  **[REC]** Implement deletion as: anonymise the user row (replace username, drop password
  hash, revoke credentials, purge sessions/claims per retention), then keep an
  `billing_records` row keyed by a pseudonymous ID with the amounts, dates and invoice
  numbers required by tax law — and say exactly this in the Datenschutzerklärung.

## 7.4 Lawful bases

- Account, service delivery, billing, invoicing, dunning: **Art. 6(1)(b) — contract**.
- Tax retention: **Art. 6(1)(c) — legal obligation**.
- Fraud/abuse detection, per-account cost tracking: **Art. 6(1)(f) — legitimate interest**
  (document a balancing test).
- **Consent (Art. 6(1)(a)) is needed only for marketing email and any non-essential
  cookies.** **[REC]** Do not build a consent flow for billing — it is the wrong basis and
  it implies a right to withdraw that you cannot honour.

## 7.5 Webhook endpoint security

**[REC]** Non-negotiable before accepting a single webhook:

1. **Verify the provider's signature on the raw body** before parsing. Reject unsigned or
   mis-signed requests with 400 and log them.
2. Enforce a **timestamp tolerance** to block replay.
3. **Idempotency by provider event ID**, stored in a table with a UNIQUE constraint —
   insert first, process second, in one transaction.
4. Respond **2xx quickly**; do the work in the same transaction only if it is cheap, else
   queue. Stripe delays invoice finalisation up to 72 hours if it does not get a successful
   response to `invoice.created` **[FACT — [Stripe webhook docs](https://docs.stripe.com/billing/subscriptions/webhooks)]**.
5. **Never trust webhook body content as authorisation** — re-read the subscription from
   the provider API when the state change is consequential (upgrade, comp removal).
6. Rate-limit and size-limit the endpoint. It is the only unauthenticated write path you
   will have added since the pairing flow.
7. Keep it outside the existing `/api/*` auth middleware, on its own path (e.g.
   `/webhooks/stripe`), with its own explicit rules.

## 7.6 PCI DSS

**[FACT — [PCI SSC](https://blog.pcisecuritystandards.org/faq-clarifies-new-saq-a-eligibility-criteria-for-e-commerce-merchants)]**
SAQ A covers merchants who fully outsource account-data handling to PCI-DSS-compliant third
parties and never store, process or transmit account data on their own systems. Under PCI
DSS v4.0.1, the script-related eligibility criteria apply to merchants **embedding** a
provider's payment form (iframe); they do **not** apply to merchants who **redirect** the
customer to the provider's site or fully outsource payment functions.

**[REC] Use a full redirect to provider-hosted checkout (Stripe Checkout / Link / Paddle
overlay-free redirect).** It keeps you in the simplest SAQ A category, keeps card data out
of your DOM entirely, and removes an entire class of script-injection risk from a codebase
that currently has no build step and no CSP.

---

# 8. Friends, testers and complimentary access

## 8.1 Naming

**[REC] Use two terms, precisely:**

- **Entitlement** — the *computed, effective* answer to "what may this account do right
  now?" It is derived, never edited directly. This is what the enforcement layer reads.
- **Plan grant** — a *record* that gives an account a plan without payment. This is what an
  admin creates.

So: "a plan grant is one source of an entitlement; a subscription is the other." Avoid
"comp subscription", "fake subscription" or "free plan" as data-model names — each of them
invites someone to write a row into the subscription table that no provider will ever
confirm, which is exactly the bug this design exists to prevent.

## 8.2 The model

```
effective_entitlement(account) =
    highest_plan_of(
        active_subscription(account),      // provider-backed, or none
        active_plan_grants(account)        // zero or more
    )
    unless account.status == 'disabled'    // admin suspension always wins
```

**Rules:**

1. **A plan grant never creates a provider customer or subscription.** A permanently free
   friend has no Stripe record at all. That is the point.
2. **Grants and subscriptions coexist.** They do not overwrite each other. If a paying
   customer is given a grant, the grant simply wins while it is active; when it expires,
   the paid subscription is still there and takes over. **[REC]** When granting to an
   account with an active paid subscription, the admin UI must ask explicitly: *keep
   billing* (grant is a bonus tier) or *pause billing* (cancel at period end via the
   provider, recorded as a separate action). Never silently cancel someone's payment.
3. **Roles are untouched.** `role` stays `user`/`admin` and continues to mean
   *administrative privilege*. `status` stays `pending`/`active`/`disabled` and continues
   to mean *may this account authenticate*. Neither ever encodes a plan. An admin has no
   plan by virtue of being an admin — they get a grant like anyone else, so that admin
   accounts exercise the same code path real customers do.
4. **Only admins may create grants, and never for themselves.** Enforce
   `grant.grantee_id != grant.granted_by` at the API layer and reject it. A second admin
   grants the first admin. **[REC]** Log every attempt.
5. **Every grant is attributed and justified.** `granted_by`, `granted_at`, `reason` (free
   text, required), `category`.
6. **Every grant is revocable** and revocation is recorded, not deleted:
   `revoked_at`, `revoked_by`, `revoke_reason`.
7. **Expiry is optional.** `expires_at NULL` = permanent. A nightly job re-computes
   entitlements; nothing needs to "run" for a grant to lapse if the computation reads
   `expires_at` live.

## 8.3 Grant categories

| Category | Expiry | Typical plan | Notes |
| --- | --- | --- | --- |
| `friend` | none | Studio | The named use case. No payment record ever exists |
| `tester` | 3–6 months, renewable | Studio | Renewal forces a periodic "is this still true?" review |
| `contributor` | 12 months, renewable | Studio | Tie to a visible contribution; renew annually |
| `sponsor` | matches sponsorship term | Studio | If sponsorship money arrives outside the payment provider, **the income is still taxable** **[ADVISER]** |
| `staff` | none | Studio | Operator's own accounts; excluded from revenue metrics |
| `promo` | fixed date | Team or Studio | Time-limited campaigns |
| `goodwill` | 1–3 months | current plan | Support remedy instead of a refund — cheaper than a refund and avoids the fee loss (§2.2) |

## 8.4 Coupons and provider discounts

**[REC] Do not build a coupon system.** Two mechanisms already cover everything:

- **Free access → plan grant** (local, no provider involvement, no fee, no invoice).
- **Discounted paid access → the provider's native coupon/promotion codes** (Stripe
  coupons, Paddle discounts). These flow through the provider's tax and invoicing logic
  correctly, which a home-grown discount never will.

A locally-invented percentage discount would have to be reflected in the invoice, the VAT
base and the accounting export. That is a lot of surface for a feature whose real use case
is "let my friend in for free" — which grants already handle for €0.

## 8.5 What this design deliberately avoids

- No rows in `subscriptions` that no provider will ever confirm (which would break
  reconciliation in §9 forever).
- No `role = 'friend'` or `role = 'pro'` — that would put billing state into the
  authorization system and violate the existing single-enforcement-point design.
- No "internal Stripe customer" for permanently free users — no PII sent to a payment
  provider for someone who will never pay.

---

# 9. Subscription and entitlement lifecycle

## 9.1 States

| State | Meaning | Access behaviour |
| --- | --- | --- |
| `none` | No subscription, no grant | **Free tier limits.** Login works; project writes limited to free caps |
| `trialing` | Provider trial running (only if a trial is ever introduced) | Full plan access |
| `active` | Paid and current | Full plan access |
| `past_due` | A renewal payment failed; retries running | **Full access during the grace window**, plus an in-app banner and email |
| `grace` | Grace window expired but not yet downgraded | **Read-only**: `GET` project state works; claims/sessions/bugs writes return 402 |
| `canceled_at_period_end` | Customer cancelled; period still running | **Full access until `current_period_end`.** No further charges. Reactivation must be one click |
| `expired` | Period ended after cancellation or failed dunning | Free tier limits. **Data retained per the free tier's retention window, then pruned** |
| `refunded` | Payment returned | Entitlement ends at the refund's effective date; usually → `expired` |
| `chargeback` | Dispute opened | **Immediate downgrade to free tier + block new checkouts for that account.** Never auto-delete |
| `comp` | Active plan grant (§8) | Full plan access. Never charged, never dunned |
| `suspended` | Admin action (`users.status = 'disabled'`) | **No access at all.** Overrides everything, including `comp` and `active` |

**Precedence, highest first:** `suspended` → `comp` → `active`/`trialing` →
`canceled_at_period_end` (until period end) → `past_due` → `grace` → `expired`/`none`.

## 9.2 Event handling

| Event | Expected behaviour |
| --- | --- |
| **Checkout completion** | Do **not** grant access from the browser redirect. The redirect only shows "we're activating your plan". Access is granted when the webhook (or an immediate server-side read of the session/subscription) confirms it. **[REC]** On the success page, do one synchronous provider API read so the common case feels instant, then let the webhook be the durable path |
| **Delayed webhooks** | The success page must poll local state and show a "this can take a moment" message. A reconciliation job (below) catches anything lost. Never leave a paying customer on the free tier because a webhook was slow |
| **Duplicate webhooks** | UNIQUE constraint on `provider_event_id`; second delivery returns 200 without re-processing. **Assume duplicates and out-of-order delivery as the normal case, not the exception** |
| **Out-of-order webhooks** | Store the provider's object version/timestamp; ignore an update whose payload is older than the state you already have |
| **Failed renewal** | `active` → `past_due`; email immediately; provider retries; 7-day grace; then `grace` (read-only); then `expired` at 14 days **[REC]** |
| **Upgrade** | Take effect **immediately**; let the provider handle proration. Entitlement raises on webhook confirmation |
| **Downgrade** | Take effect **at period end** — no refund needed, no proration argument, and the customer keeps what they paid for. If the new tier's limits are lower than current usage, warn at the moment of downgrade and enforce at the switch |
| **Cancellation** | Set `cancel_at_period_end`; access continues; send the §312k confirmation email immediately; show the end date in the UI |
| **Refund** | Recompute the entitlement from the refund's effective period. A full refund of the current period ends access now; a goodwill partial refund does not change access |
| **Chargeback** | Downgrade immediately, flag the account, block new checkouts, notify the operator. **[REC]** Do not delete data and do not auto-ban the human — chargebacks are sometimes bank errors |
| **Provider outage** | **Fail open.** Local entitlement state keeps serving; if `current_period_end` is in the future, access continues regardless of provider reachability. Never let a Stripe outage lock out paying customers. Queue outbound calls; retry checkout creation with backoff |
| **User deletes their account** | Cancel the subscription at the provider (immediately, with a final invoice per the provider's rules), revoke credentials, purge sessions/claims per retention, anonymise the user row, **keep the billing records required by §147 AO** (§7.3) |
| **Admin disables an account** | `users.status = 'disabled'` blocks access at once. **[REC]** Do **not** auto-cancel billing — the operator decides separately whether to refund or cancel, and that decision must be logged. Otherwise a moderation action silently becomes a financial action |

## 9.3 Authoritative source

**Local entitlement state is authoritative for every request.** Enforcement must never make
a network call to the provider — that would put a third party in the critical path of every
API request and violate the "don't couple authentication to the payment provider" rule.

- **Webhooks** are the primary *change feed* — they mutate local state.
- **The provider API is the tiebreaker.** On any conflict, the provider wins and local
  state is corrected.
- **Reconciliation job [REC]:** hourly, list subscriptions changed since the last run and
  correct drift; nightly, full compare of every locally-active subscription against the
  provider; alert on any discrepancy. Reconciliation is the reason webhook loss is
  survivable — it is not optional infrastructure.

---

# 10. Abuse and fair-use controls

**[REC] Hard limits for anything that costs money; soft limits for anything that only
affects experience.**

| Control | Design |
| --- | --- |
| **Hard limits** | Concurrent sessions, projects, members, active claims, storage, retention. Exceeding returns **HTTP 402 with a machine-readable reason and an upgrade URL** — agents can parse and report it, which fits this product's protocol |
| **Soft limits** | Request rate: throttle (429 + `Retry-After`) rather than refuse. A coordination service that hard-fails on a burst is worse than useless — the agent will silently stop coordinating |
| **Rate limits** | Per credential *and* per account *and* per IP. Token bucket, in-process is fine for a single node. **[REC]** Tie the burst allowance to the tier |
| **Concurrency limits** | The most important limit for this product, because concurrent agent sessions is what actually consumes the server |
| **Storage limits** | Bytes per account, enforced on write, plus per-request body size caps |
| **Retention limits** | Enforced by a pruning job, per tier (§2.2). **This is the only thing preventing unbounded disk growth** |
| **Fair-use clause** | Published numeric limits + a clause reserving the right to throttle or suspend usage that endangers service stability, with notice except in emergencies **[ADVISER]** |
| **Abuse detection** | Alert on: sustained request rate ≫ tier norm, session count at cap for extended periods, many distinct machines on one account, credential creation velocity, payloads near the size cap, one account dominating total traffic |
| **Manual suspension** | Already exists (`users.status = 'disabled'`) and already overrides everything. **[REC]** Add a lighter `throttled` flag so the answer to abuse is not only the nuclear option |
| **Cost alerts** | Alert on server CPU, disk %, DB file size, and monthly bandwidth against the included 20 TB |
| **Per-user cost tracking** | Cheap proxy metrics recorded per account per day: requests, bytes out, peak concurrent sessions, DB bytes. **[REC]** These double as the §2.6 measurements — build them *before* pricing is fixed, not after |
| **Emergency global limits** | A global kill switch: a config-driven cap on total concurrent sessions and a global rate limit, so one bad actor degrades rather than destroys. **[REC]** Also an emergency read-only mode |
| **Account sharing** | Detectable via distinct machines and developers per credential (already recorded in `credentials`: `agent`, `machine`, `developer`). **[REC]** Treat sharing as an upsell trigger, not a ban trigger — the member cap does the real work |
| **Automated abuse** | Registration is already gated by admin approval. **[REC]** Keep approval on for the free tier at launch; it is the cheapest anti-abuse control available and it already exists |

**[REC] On "effectively unlimited":** publish the €25 numbers. Market it as *"limits you
will not notice"*. A concrete number that is 10× anyone's real usage sells as well as
"unlimited" and bounds the loss.

---

# 11. Technical architecture proposal

Not to be implemented now. Constraints inherited from `AGENTS.md`: `core` imports nothing;
`server` may import `core`; enforcement stays at the single `/api/*` middleware point.

## 11.1 Data (conceptual — no migrations written)

| Table | Purpose | Key fields |
| --- | --- | --- |
| `billing_customers` | Local ↔ provider link. **Only for accounts that have actually transacted** | `user_id` (unique), `provider`, `provider_customer_id`, `billing_email`, `country`, `vat_id`, timestamps |
| `subscriptions` | Provider-backed subscriptions only. **Never written by an admin** | `user_id`, `provider_subscription_id`, `plan_code`, `status`, `current_period_start/end`, `cancel_at_period_end`, `provider_updated_at` |
| `plan_grants` | Complimentary access (§8) | `user_id`, `plan_code`, `category`, `reason`, `granted_by`, `granted_at`, `expires_at` (nullable), `revoked_at`, `revoked_by`, `revoke_reason` |
| `plans` | Static plan definitions, **in `src/core/`** | `code`, display name, price ids per provider, and the full numeric limit set |
| `usage_counters` | Daily per-account counters | `user_id`, `day`, `requests`, `bytes_out`, `peak_sessions`, `db_bytes` |
| `webhook_events` | Idempotency + audit | `provider`, `provider_event_id` **UNIQUE**, `type`, `received_at`, `processed_at`, `status`, `payload` (short retention) |
| `billing_audit` | Every state change with an actor | `at`, `actor` (`system`/`webhook`/`admin:<id>`/`user:<id>`), `subject_user_id`, `action`, `from`, `to`, `note` |

Plan → limits mapping belongs in `src/core/plans.ts` as pure data, because it is domain
knowledge with no I/O — the same rule that puts overlap logic in `src/core/overlap.ts`.

## 11.2 Modules

- `src/core/plans.ts` — plan codes, limits, precedence. Pure.
- `src/core/entitlements.ts` — `computeEntitlement(subscription | null, grants[], userStatus)`.
  **Pure and unit-testable, which is the whole point:** the precedence rules of §9.1 get
  tested without a database or a network.
- `src/server/billing/store.ts` — the tables above.
- `src/server/billing/provider.ts` — a thin interface (`createCheckoutSession`,
  `createPortalSession`, `cancelAtPeriodEnd`, `getSubscription`, `verifyWebhook`) with one
  implementation. **The interface is not speculative abstraction — it is what keeps the
  MOR-vs-direct decision (§3) reversible.**
- `src/server/billing/webhooks.ts` — signature verification, idempotent insert, state
  transitions.
- `src/server/billing/reconcile.ts` — the job from §9.3.

## 11.3 Enforcement

**One added check inside the existing middleware in `src/server/app.ts`, not scattered
around.** After identity resolution, resolve the entitlement for the acting user (for agent
credentials: the user who owns the credential — **note that `credentials` currently records
`developer` as free text and has no `user_id` FK, so linking a credential to an account is
prerequisite work**), then apply the route's requirement.

| Endpoint | Requirement |
| --- | --- |
| `GET /api/health` | **Public** — never gated |
| `POST /api/users/register`, `/login`, `/logout` | **Public** — never gated |
| `GET /api/users/me` | **Authenticated only** — a user must always be able to see their own state, including that they have no plan |
| `GET /api/users`, `PATCH/DELETE /api/users/:id` | **Admin only** — never gated by billing |
| `POST /api/auth/request`, `/redeem`, `GET /api/auth/me` | **Public** — pairing must work before payment; the entitlement check happens on the project routes |
| `GET /api/auth/pending`, `/credentials`, `DELETE /api/auth/credentials/:id` | **Authenticated** — credential hygiene must never be paywalled |
| `GET /api/projects` | **Authenticated**; result filtered by entitlement |
| `POST /api/projects/:p/sessions`, `.../heartbeat`, `.../repo` | **Entitlement required** — this is the metered resource |
| `POST/PATCH /api/projects/:p/claims*`, `/bugs*` | **Entitlement required** |
| `GET /api/projects/:p/state`, `/check` | **Entitlement required**, but **read-only should degrade rather than 402** in `grace`/`expired` for existing projects — an agent that cannot read state will duplicate work, which is the failure the product exists to prevent |
| `POST /api/billing/checkout`, `GET /api/billing/portal`, `POST /api/billing/cancel` | **Authenticated, never gated** — you cannot paywall the ability to pay |
| `GET /api/billing/status` | **Authenticated, never gated** |
| `POST /webhooks/:provider` | **Public, signature-verified** — outside `/api/*` entirely |
| `/`, `/AGENT.md`, `/auth.md`, `/install.sh`, `/install/*`, legal pages, `/kuendigen`, `/widerruf` | **Public** — both cancellation and withdrawal pages must work without login (§5.5, §5.6.1) |

**Do not couple authentication to the payment provider.** Login, pairing and credential
management must work with the provider unreachable. Entitlement resolution reads local
state only.

## 11.4 Prerequisite work already visible in the codebase

1. **Add a verified `billing_email` to `billing_customers`** — invoices, dunning and the
   §312k confirmation are impossible without a contact address, but that does **not**
   require changing the username-based identity model in `users`. Collect and verify the
   email when a user *starts checkout*; require it only for paying accounts (and,
   optionally later, for account recovery). Permanently complimentary friends keep having
   no email and no provider record. A universal `users.email` may be worth adding later
   for its own reasons; it is not a payment-system prerequisite. Note: a provider-hosted
   checkout (Stripe) collects the customer's email itself — the webhook delivers it, so
   "verify" can mean "the provider verified receipt-deliverability", with a local
   confirmation loop only if the address is also used for dunning outside the provider.
2. **Link `credentials` to `users`** (`user_id` FK) — otherwise agent traffic cannot be
   attributed to a paying account.
3. **Fix `cors()` open-to-all** (`src/server/app.ts:68`) — a credentialed billing endpoint
   behind wildcard CORS is a real problem.
4. **Set `Secure` on the session cookie** (`src/server/app.ts:42`) once TLS is guaranteed.
5. **Add usage counters** (§10) — needed before pricing is final (§2.6).
6. **Add a pruning job** for retention — the current schema retains completed claims and
   bugs forever.

---

# 12. Recommended launch stages

### Stage 1 — Private use and invited friends (no money)

- **Legal:** Impressum, Datenschutzerklärung, short beta notice. No AGB strictly needed.
- **Payment:** none. **Plan grants only** (§8) — build the entitlement model here, with no
  provider at all. This is the single highest-value sequencing decision in this document:
  the grant path and the enforcement path get exercised for months before any money is at
  risk.
- **Accounting:** none, if nothing is charged. **[ADVISER]** Confirm that free access to
  friends creates no tax event.
- **Monitoring:** uptime + disk + error rate.
- **Manual:** everything — grants by SQL if necessary, approvals by hand.
- **Blocks Stage 2:** entitlement computation not covered by tests; usage counters absent;
  no email delivery; CORS/cookie issues open.

### Stage 2 — Closed paid beta (Germany only, invited, ≤ ~20 customers)

- **Decide first: B2B-only or B2C (§5.10).** This decision defines the whole legal
  surface of this stage.
  - **Mode 2 (verified B2B-only) [REC]:** no Widerrufsbelehrung, no §312k button, no
    §356a Widerrufsbutton, no §§327ff duties — instead the B2B restriction package
    (prominent notices, checkout confirmation checkbox, mandatory company field),
    legally reviewed.
  - **Mode 3 (B2C included):** the full list below.
- **Legal (B2C path):** AGB, Widerrufsbelehrung + model form, subscription/cancellation
  terms, **§312k cancellation button live**, **§356a electronic withdrawal function
  (`/widerruf`) live** (§5.6.1), pricing + fair-use policy (Kleinunternehmer price wording
  per §5.2 — no "inkl. MwSt."), refund policy. Legal review of AGB, Widerruf and both
  button flows **[REC]**.
- **Business:** **Gewerbeanmeldung**, Fragebogen zur steuerlichen Erfassung,
  **Kleinunternehmerregelung elected** **[ADVISER]**, business bank account.
- **Payment:** hosted checkout (redirect), webhooks with idempotency, customer portal,
  cancellation flow, dunning emails, one plan (€5) plus grants. **[REC]** Stripe direct
  for this stage (§3.3); Managed Payments only after the Steuerberater has answered the
  MOR accounting questions in writing. Skip annual until monthly works.
- **Accounting:** revenue and fee records, invoice archive, 8-year retention plan, monthly
  reconciliation against the provider payout.
- **Monitoring:** payment failures, webhook failures, entitlement drift.
- **Manual:** refunds, upgrades, comp grants, invoice corrections — all by hand.
- **Blocks Stage 3:** any unexplained entitlement drift; webhook loss without
  reconciliation catching it; missing §312k confirmation emails; no measured unit costs.

### Stage 3 — Germany-only public launch

- **Legal:** everything from Stage 2, reviewed. **If Stage 2 was B2B-only and Stage 3
  opens to consumers, the full B2C surface (§312k + §356a buttons, Widerrufsbelehrung,
  §§327ff duties incl. §327p data export) becomes a blocker here instead.** Alternatively
  stay B2B-only publicly and keep the restriction package. Restrict checkout to German customers
  **[REC]** — an explicit country selection plus provider-side restriction, so the €10,000
  EU threshold cannot be crossed by accident.
- **Payment:** €5 and €25 tiers, monthly + annual, upgrades/downgrades, price-change
  notice flow.
- **Accounting:** Kleinunternehmer VAT position monitored monthly against the €25,000 /
  €100,000 limits.
- **Monitoring:** per-account cost tracking, abuse alerts, cost alerts, revenue dashboard.
- **Manual:** dunning exceptions, goodwill grants.
- **Blocks Stage 4:** no plan for cross-border VAT; support load per customer unmeasured;
  refund/chargeback rates unknown.

### Stage 4 — EU launch

- **The VAT decision has to be made here** (§4.6/§4.7):
  - **[REC] Path A — switch to a merchant of record** and let the provider carry OSS. Least
    work, ≈ 3 % of gross.
  - Path B — register for **OSS with the BZSt**, charge each country's rate, file
    quarterly, use Stripe Tax for determination. **[ADVISER]**
  - Path C — stay under **€10,000** of cross-border B2C and charge German VAT, or use
    **§19a** EU-Kleinunternehmer. Viable only while genuinely small; needs monitoring.
- **Legal:** localised pre-contract information; check consumer-law variations per market;
  keep German documents authoritative with a stated governing law **[ADVISER]**.
- **Payment:** local payment methods (SEPA DD is the one that matters for recurring in DE/
  NL/AT), EU B2B VAT ID collection + validation + reverse charge, **Zusammenfassende
  Meldung** process if selling B2B.
- **Monitoring:** VAT-by-country report, threshold alerts.
- **Blocks Stage 5:** OSS/MOR not operating cleanly for two full quarters.

### Stage 5 — Broader international

- **Legal:** US/UK/CH/AU tax thresholds; consumer-law regimes far from EU norms.
- **[REC] Only via a merchant of record.** Registering for US state sales tax, UK VAT and
  the rest as a German sole trader is not a rational use of a one-person team's time at
  any revenue this product will plausibly reach in its first years.
- **Blocks progression:** if a direct-processor setup is still in place, do not open
  non-EU sales beyond whatever the provider handles.

---

# 13. Final recommendation

## 13.1 Pricing and plans

**Free** (strict: 1 member, 1 project, 2 sessions, 7-day history) →
**Team €5/month or €50/year** (5 members, 25 projects, 25 sessions, 180-day history) →
**Studio €25/month or €250/year** (25 members, 250 projects, 150 sessions, 730-day history,
published numeric caps, fair-use clause).

**Drop the €1 monthly tier.** If the price point is wanted, the financially plausible form
is **Solo at €12/year, annual only** — same headline price, 4.3 % fees instead of 27 %.
**[REC] But do not launch it.** Introduce Solo only if the beta demonstrates real demand
in the gap between Free and €5; otherwise it adds a fourth product, another entitlement
definition, another upgrade path and another support distinction for near-zero revenue.
All prices displayed as VAT-inclusive totals from day one (see §5.2 for the exact
Kleinunternehmer wording — not "inkl. MwSt."), so the Kleinunternehmer→VAT transition
never changes the sticker price. No overages. No usage billing. No credits. No trial (the
free tier is the trial).

**[ASSUMPTION]** All numeric tier limits remain provisional until the §2.6 measurements
exist (see §1.1). Publish beta limits as adjustable; fix public limits only after load
testing.

## 13.2 Payment provider

**Conditional, per §3.3 and §5.10:**

- **Constrained German beta (Stages 2–3, especially if B2B-only): Stripe direct**
  (Checkout + Billing + Portal; add Tax when VAT-registered). Cheapest (7.2 % at €5),
  SEPA DD available, and while Germany-only + Kleinunternehmer there is no cross-border
  VAT work for an MOR to remove.
- **Broader B2C / EU / international distribution (Stage 4+): Stripe Managed Payments**
  (+3.5 % on the tax-inclusive amount, on top of processing and Billing fees; GA for
  German sellers) — **only after** a Steuerberater has confirmed in writing how the
  Sold-through-Link self-billing flow, the MOR payout and the §19 UStG threshold
  interaction are booked (§3.3, §13.8 Q3). Known limitations to accept: no SEPA DD,
  non-customisable Stripe invoices, dispute fees not fully absorbed, `/kuendigen` and
  `/widerruf` still yours to build.

Same Stripe account and objects either way; build against the thin provider interface in
§11.2 so the direct↔MOR switch stays cheap.

**Avoid** Paddle (does not price products under $10 at list), Lemon Squeezy (superseded),
and PayPal-only (weakest API, worst fees at these amounts).

## 13.3 Tax and legal setup for an initial German launch

Einzelunternehmen; Gewerbeanmeldung under §14 GewO; Fragebogen zur steuerlichen Erfassung
via ELSTER; **elect the Kleinunternehmerregelung** (≤ €25,000 prior year / ≤ €100,000
current year); EÜR accounting; Gewerbesteuer irrelevant below the €24,500 allowance;
Germany-only sales until the EU VAT path is chosen. Documents: Impressum (§5 DDG),
Datenschutzerklärung, AGB, subscription/cancellation terms, and — for B2C —
Widerrufsbelehrung + model form plus the §312k and §356a button pages; for B2B-only, the
§5.10 restriction package instead. Pricing and fair-use policy (Kleinunternehmer price
wording per §5.2), refund policy. All **[ADVISER]**.

## 13.4 Complimentary access

Two independent sources — `subscriptions` (provider-backed only) and `plan_grants`
(admin-issued) — resolved by a pure `computeEntitlement()` function with the precedence
`suspended > comp > paid`. Grants carry `granted_by`, `reason`, optional `expires_at`, and
revocation fields; self-granting is rejected; permanently free users never get a provider
customer record. `role` and `status` keep their current meanings and never encode a plan.
Terminology: **entitlement** (computed) and **plan grant** (record).

## 13.5 Minimum billing architecture

Seven tables (§11.1); a pure entitlement function in `core`; one provider adapter;
signature-verified idempotent webhooks on a path outside `/api/*`; hourly + nightly
reconciliation; enforcement added at the single existing middleware point; local state
authoritative at request time; fail open on provider outage.

## 13.6 Exact work required before accepting the first payment

1. Add verified `billing_email` to `billing_customers` (collected at checkout — not a
   `users` schema change); wire transactional email.
2. Add `user_id` to `credentials` so agent traffic maps to an account.
3. Fix wildcard CORS and set `Secure` on the session cookie.
4. Plan definitions + `computeEntitlement()` in `core`, with tests covering every
   precedence rule in §9.1.
5. Enforcement in the `/api/*` middleware; 402 with a machine-readable body.
6. Usage counters and the retention-pruning job.
7. Provider adapter: hosted checkout (redirect), portal, cancel, get-subscription.
8. Webhook endpoint: signature verification, `provider_event_id` UNIQUE, transactional
   processing, audit rows.
9. Reconciliation job + drift alert.
10. Billing UI: plan page, status page, portal link, **public no-login `/kuendigen` page**
    and — for B2C — **public no-login `/widerruf` page (§356a)**, kept separate. If the
    B2B-only mode of §5.10 is chosen instead: the restriction package (notices, checkout
    confirmation, company field), legally reviewed.
11. Emails: order confirmation, invoice/receipt, payment failure, dunning, **§312k
    cancellation confirmation**, **§356a withdrawal receipt confirmation**, price-change
    notice.
12. Legal pages published and linked from checkout; consent versions logged.
13. Gewerbeanmeldung + Finanzamt registration + business bank account.
14. Invoice archive with 8-year retention and an export the accountant can read.
15. Backup and restore tested — **you are now holding other people's money-backed state**.

## 13.7 Work that can be postponed

Annual billing (add once monthly is stable), coupons of any kind, trials, proration
subtleties, self-service refunds, multi-currency, tax-ID collection (unless the B2B-only
mode of §5.10 is chosen — its company field and checkout confirmation are then in scope,
though VAT-ID validation can still wait), B2B invoicing,
dunning experiments, revenue analytics, a second payment provider, the UG conversion,
e-invoicing (not required for B2C, and Kleinunternehmer invoices are exempt), and the
Solo €12/year tier.

## 13.8 Questions for a Steuerberater or Rechtsanwalt

1. Is operating this hosted service **gewerblich or freiberuflich** for me specifically?
2. Should I elect the **Kleinunternehmerregelung**, given planned growth and the mid-year
   €100,000 hard cut-off?
3. Selling through a **merchant of record**: what exactly is my supply, to whom, at what
   place of supply, and how is the MOR's payout booked and invoiced?
4. Do I need a **USt-IdNr.** and **Zusammenfassende Meldungen** from day one if any EU
   business customers appear?
5. For EU consumers: **§19a EU-Kleinunternehmerregelung, the €10,000 threshold, or OSS** —
   which, and when does the choice have to be made?
6. Does a provider-hosted portal satisfy **§312k BGB**, or is a public no-login cancellation
   page on my own domain mandatory? Same question for the **§356a Widerrufsbutton** — and
   under an MOR, do §312k/§356a duties formally sit with me or with the MOR as the
   consumer's contract counterparty?
7. Should I extinguish the **withdrawal right** at checkout (double consent) or simply
   honour 14 days and refund pro rata? Review my `/widerruf` implementation against §356a
   (labels, form fields, confirmation email).
7a. **Managed Payments specifics:** does turnover sold through the MOR count toward the
   §19 UStG €25,000/€100,000 thresholds? Is the Sold-through-Link **self-billed invoice**
   acceptable for my EÜR/GoBD bookkeeping? Do Stripe's EU-entity fees trigger a **§13b
   reverse charge** that I, as Kleinunternehmer, must pay without input-VAT deduction?
7b. Is my **B2B-only restriction** (notices + checkout confirmation + company field)
   sufficient to keep consumer law out, per OLG Hamm 12 U 52/16?
8. Review of **AGB liability and availability clauses** for a service whose failure mode is
   duplicated developer work.
9. Does giving friends free **Studio access** create any tax event (Sachbezug, gift, or
   nothing)?
10. What **retention and deletion** design satisfies both §147 AO and Art. 17 GDPR for a
    deleted account?
11. Does the **monthly-Voranmeldung suspension expiring 31 Dec 2026** affect a 2027 launch?
12. Is a **UG** worth the administration at my expected revenue, purely for liability?

## 13.9 Major risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| **€1 tier destroys unit economics** | High | Already recommended against; annual-only if the price point is wanted |
| **Support cost per customer exceeds €5-tier margin** | High | Measure contacts/user early (§2.6); docs-first support; a single support contact per month at €5 is roughly the whole month's margin |
| **§312k non-compliance** | High | Consumers could cancel at any time without notice; build the public cancellation page, do not rely on the provider portal |
| **§356a Widerrufsbutton missing (B2C)** | High | Withdrawal period extends up to 12 months + 14 days, plus Abmahnung risk; build the public `/widerruf` page (§5.6.1) — no provider supplies it |
| **B2B-only restriction fails in court** | Medium-high | AGB clause alone is insufficient (OLG Hamm); if the restriction fails, all consumer duties applied retroactively — implement the full package and have it reviewed |
| **Wrong VAT treatment on cross-border sales** | High | Germany-only until Stage 4; MOR removes most of it |
| **Disk growth from retained claims/bugs** | Medium-high | The pruning job is not optional |
| **Willingness to pay is unproven** | High | Nothing in this document establishes that anyone will pay €5 for this. **[REC] Stage 2 exists precisely to test that, and the free tier's conversion rate is the number that decides whether the business exists** |
| **MIT licence lets anyone self-host** | Medium | The paid product is the hosted instance; revisit licensing before public launch if it matters |
| **MOR lock-in** | Medium | Thin provider interface; the customer relationship sits with the MOR — a real cost of the recommendation |
| **Chargeback on a €5 subscription costs €20** | Medium | Clear descriptor, clear emails, easy self-service cancellation, refund before disputing |
| **EU-US DPF invalidated by future litigation** | Medium | Hoster already German; keep US processors few and substitutable |
| **Single SQLite writer becomes the ceiling** | Medium | Measure it (§2.6) before selling 150-session plans |
| **New-business monthly VAT filing returns in 2027** | Low-medium | Confirm with the adviser if launching in 2027 |
| **Digital Fairness Act (Q4 2026) tightens subscription rules** | Low now, rising | Design cancellation and renewal flows conservatively from the start |

## 13.10 The recommendation in one paragraph

> Launch invited friends using permanent or time-limited Studio **plan grants** — no
> payments, no provider. **Instrument real usage before fixing public limits**; every
> numeric limit in this document is a provisional safety limit until the §2.6
> measurements exist. For the first paid beta, **decide explicitly between verified
> B2B-only sales and B2C sales** (§5.10) — that decision, not the provider, defines the
> legal surface. Use **Free / €5 / €25** as the initial commercial structure, no
> overages, no trial; add annual once monthly is stable, and the €12/year Solo tier only
> if demand between Free and €5 is demonstrated. **Keep username-based authentication**
> and collect the billing contact email separately at checkout. Select **Stripe direct
> for a constrained German beta**; move to **Stripe Managed Payments for broader
> B2C/international distribution only after a Steuerberater has confirmed the German
> accounting treatment of the MOR flow in writing**. Before any B2C launch, implement
> and have legally reviewed **both** the §312k cancellation function *and* the §356a
> electronic withdrawal function, with the Kleinunternehmer price wording of §5.2 (no
> "inkl. MwSt.").

---

## Sources

**Providers**
[Stripe pricing (DE)](https://stripe.com/de/pricing) ·
[Stripe Managed Payments](https://stripe.com/managed-payments) ·
[Managed Payments — how it works](https://docs.stripe.com/payments/managed-payments/how-it-works) ·
[Managed Payments pricing](https://support.stripe.com/questions/managed-payments-pricing) ·
[Managed Payments changelog (Feb 2026)](https://docs.stripe.com/changelog/clover/2026-02-25/managed-payments) ·
[Stripe Tax docs](https://docs.stripe.com/tax) ·
[Stripe currencies / minimum amounts](https://docs.stripe.com/currencies) ·
[Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks) ·
[Stripe customer portal](https://docs.stripe.com/customer-management) ·
[Stripe DPA](https://stripe.com/legal/dpa) ·
[Stripe DPA FAQs](https://stripe.com/legal/dpa/faqs) ·
[Paddle pricing](https://www.paddle.com/pricing) ·
[Paddle GDPR](https://www.paddle.com/legal/gdpr) ·
[Paddle DPA](https://www.paddle.com/legal/data-processing-addendum) ·
[Polar pricing](https://polar.sh/resources/pricing) ·
[Mollie pricing (DE)](https://www.mollie.com/de/pricing) ·
[PayPal merchant fees (DE)](https://www.paypal.com/de/webapps/mpp/merchant-fees) ·
[Lemon Squeezy — Stripe acquisition](https://www.lemonsqueezy.com/blog/stripe-acquires-lemon-squeezy) ·
[Hetzner CX plans](https://www.hetzner.com/pressroom/new-cx-plans/) ·
[Resend pricing](https://resend.com/pricing)

**German law and tax**
[§14 GewO](https://www.gesetze-im-internet.de/gewo/__14.html) ·
[§11 GewStG](https://www.gesetze-im-internet.de/gewstg/__11.html) ·
[§19 UStG](https://www.gesetze-im-internet.de/ustg_1980/__19.html) ·
[§3a UStG](https://www.gesetze-im-internet.de/ustg_1980/__3a.html) ·
[§18 UStG](https://www.gesetze-im-internet.de/ustg_1980/__18.html) ·
[§18a UStG](https://www.gesetze-im-internet.de/ustg_1980/__18a.html) ·
[§147 AO](https://www.gesetze-im-internet.de/ao_1977/__147.html) ·
[§5 DDG](https://www.gesetze-im-internet.de/ddg/__5.html) ·
[§309 BGB](https://www.gesetze-im-internet.de/bgb/__309.html) ·
[§312j BGB](https://www.gesetze-im-internet.de/bgb/__312j.html) ·
[§312k BGB](https://www.gesetze-im-internet.de/bgb/__312k.html) ·
[§356 BGB](https://www.gesetze-im-internet.de/bgb/__356.html) ·
[BMF: Sonderregelung für Kleinunternehmer (18.03.2025)](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/Umsatzsteuer-Anwendungserlass/2025-03-18-sonderregelung-kleinunternehmer.pdf?__blob=publicationFile&v=4) ·
[BZSt — One-Stop-Shop (EU)](https://www.bzst.de/DE/Unternehmen/Umsatzsteuer/One-Stop-Shop_EU/one_stop_shop_eu_node.html) ·
[BZSt — Zusammenfassende Meldung](https://www.bzst.de/DE/Unternehmen/Umsatzsteuer/ZusammenfassendeMeldung/zusammenfassendemeldung_node.html) ·
[IHK Stuttgart — Kleinunternehmerregelung](https://www.ihk.de/stuttgart/fuer-unternehmen/recht-und-steuern/steuerrecht/umsatzsteuer-national/kleinunternehmerregelung-in-der-umsatzsteuer-1843632) ·
[IHK Stuttgart — Pflichtangaben für Rechnungen](https://www.ihk.de/stuttgart/fuer-unternehmen/recht-und-steuern/steuerrecht/umsatzsteuer-national/neue-pflichtangaben-fuer-rechnungen-684834) ·
[IHK Stuttgart — E-Rechnung ab 2025](https://www.ihk.de/stuttgart/fuer-unternehmen/recht-und-steuern/steuerrecht/steuermeldungen/e-rechnungen-5864496) ·
[IHK Rhein-Neckar — OSS](https://www.ihk.de/rhein-neckar/recht/steuerrecht/e-commerce-one-stop-shop-verfahren-6844666) ·
[IHK Chemnitz — Impressumspflicht](https://www.ihk.de/chemnitz/recht-und-steuern/rechtsinformationen/internetrecht/pflichtangaben-im-internet-die-impressumspflicht-4401580) ·
[IHK Darmstadt — Kündigungsbutton](https://www.ihk.de/darmstadt/produktmarken/recht-und-fair-play/online-auftritt/kuendigungsbutton-5557048) ·
[IHK Bodensee-Oberschwaben — Gewerbe vs. freier Beruf](https://www.ihk.de/bodensee-oberschwaben/recht/gesetzliche-vorgaben-fuers-gewerb-/gewerbe-industrie-freier-beruf/abgrenzung-gewerbebetrieb-freier-beruf-1937606) ·
[IHK Osnabrück — Preisangaben bei Kleinunternehmern](https://www.ihk.de/osnabrueck/recht-und-fair-play/recht/internetrecht/preisangaben-bei-umsatzsteuer-befreiten-kleinunternehmern-1085390) ·
[IHK Düsseldorf — Aussetzung monatlicher Voranmeldungen](https://www.ihk.de/duesseldorf/existenzgruendung/aktuelles/aussetzung-der-pflicht-zur-monatlichen-uebermittlung-voranmeldungen-in-neugruendungsfaellen-4996474) ·
[Verbraucherzentrale — Kündigungsbutton](https://www.verbraucherzentrale.de/vertraege-reklamation/kuendigungsbutton-nicht-gefunden-so-muss-die-onlinekuendigung-aussehen-78472) ·
[§356a BGB — elektronische Widerrufsfunktion](https://www.gesetze-im-internet.de/bgb/__356a.html) ·
[§312 BGB](https://www.gesetze-im-internet.de/bgb/__312.html) ·
[§327 BGB](https://www.gesetze-im-internet.de/bgb/__327.html) ·
[§327f BGB](https://www.gesetze-im-internet.de/bgb/__327f.html) ·
[§327p BGB](https://www.gesetze-im-internet.de/bgb/__327p.html) ·
[§327r BGB](https://www.gesetze-im-internet.de/bgb/__327r.html) ·
[§14 BGB](https://www.gesetze-im-internet.de/bgb/__14.html) ·
[§3 PAngV](https://www.gesetze-im-internet.de/pangv_2022/__3.html) ·
[§34a UStDV](https://dejure.org/gesetze/UStDV/34a.html) ·
[§2 BFSG](https://www.gesetze-im-internet.de/bfsg/__2.html) ·
[§3 BFSG](https://www.gesetze-im-internet.de/bfsg/__3.html) ·
[Noerr — Umsetzungsgesetz zum Widerrufsbutton](https://www.noerr.com/de/insights/umsetzungsgesetz-zum-widerrufsbutton-veroeffentlicht) ·
[Luther — Widerrufsbutton §356a BGB](https://www.luther-lawfirm.com/newsroom/blog/detail/widerruf-per-klick-was-unternehmen-beim-neuen-widerrufsbutton-nach-356a-bgb-nf-beachten-muessen) ·
[shopbetreiber-blog — Widerrufsbutton ab 19.6.2026](https://shopbetreiber-blog.de/ab-19.6.2026-der-widerrufsbutton-kommt) ·
[ratgeberrecht.eu — Widerrufsbutton](https://www.ratgeberrecht.eu/aktuell/der-widerrufsbutton-kommt-zum-19-06-2026/) ·
[IHK Gera — Preisangaben als Kleinunternehmer](https://www.ihk.de/gera/recht-und-steuern/aktuelles-rechtundsteuern/preisangaben-als-kleinunternehmer-6323026) ·
[IT-Recht Kanzlei — Kleinunternehmer & MwSt-Hinweis](https://www.it-recht-kanzlei.de/kleinunternehmer-mehrwertsteuer-umsatzsteuer.html) ·
[ra-plutte — B2B-only Onlineshop (OLG Hamm 12 U 52/16)](https://www.ra-plutte.de/onlineshop-beschraenkung-b2b-kunden/) ·
[CMS — B2B-Shops müssen Verbraucher aktiv ausschließen](https://cms.law/de/deu/legal-updates/B2B-Online-Shops-muessen-Verbraucher-innen-aktiv-ausschliessen) ·
[Stripe — MP: which invoices will I receive](https://support.stripe.com/questions/which-invoices-will-i-receive-for-managed-payments-transactions) ·
[Stripe — Sold through Link, LLC entity](https://support.stripe.com/questions/why-is-sold-through-link-llc-the-legal-entity-on-my-invoice-for-stripe-managed-payments-fees) ·
[Stripe — Managed Payments eligibility](https://docs.stripe.com/payments/managed-payments/eligibility) ·
[Stripe — §312k cancellation button article](https://stripe.com/en-de/resources/more/mandatory-cancellation-button-germany)

**EU**
[Regulation (EU) 2024/3228 — ODR platform discontinuation](https://eur-lex.europa.eu/eli/reg/2024/3228/oj/eng) ·
[European Commission — consumer redress site relocation](https://consumer-redress.ec.europa.eu/site-relocation_en) ·
[European Parliament — Digital Fairness Act legislative train](https://www.europarl.europa.eu/legislative-train/theme-protecting-our-democracy-upholding-our-values/file-digital-fairness-act) ·
[European Commission — adequacy decisions](https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/adequacy-decisions_en) ·
[EDPB — EU-US DPF FAQ for businesses v2.0 (Jan 2026)](https://www.edpb.europa.eu/system/files/2026-01/edpb_dpf_faq-for-businesses_v2_en.pdf) ·
[PCI SSC — SAQ A eligibility criteria FAQ](https://blog.pcisecuritystandards.org/faq-clarifies-new-saq-a-eligibility-criteria-for-e-commerce-merchants)
