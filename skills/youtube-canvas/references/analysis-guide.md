# Analysis guide

Use this guide when converting the transcript into `analysis.json`.

## Goal

Produce a compact semantic map of the video that is worth navigating spatially.

The canvas should feel like somebody watched the whole thing carefully and pinned the useful parts to a wall.

## Two modes

### Research mode

Default for talks, lectures, interviews, technical explanations, design reviews, and podcasts.

- 8–20 segments for roughly 45–150 minutes
- 2–6 clusters
- richer summaries
- favor relationships and synthesis over chronology

### Watch mode

Use when the user wants dense notes while preserving more of the video's progression.

- roughly 1 segment per 3–8 useful minutes, not uniform sampling
- short summaries
- more timestamps
- chronology matters more than thematic compression

## Segment selection

Every segment must have a reason to exist.

Prefer moments containing:

- definition of a core concept
- causal explanation / mechanism
- architecture diagram or system decomposition
- non-obvious constraint
- concrete example that clarifies an abstraction
- code/demo that demonstrates behavior
- comparison or tradeoff
- failure mode
- strong conclusion or synthesis

Avoid splitting one continuous idea into several cards unless each sub-part has independent revisit value.

## Clusters

Clusters are semantic neighborhoods, not arbitrary buckets.

Good cluster labels:

- "Rendering model"
- "Failure modes"
- "Migration strategy"
- "Economics"

Bad cluster labels:

- "Part 1"
- "Other"
- "More stuff"

A chronological video can still produce thematic clusters. Preserve chronology through timestamps inside each card.

## Summaries

Overall summary: 3–7 sentences.

Segment summary: 1–4 sentences, dense and concrete.

`whyItMatters`: one short sentence explaining why this segment deserves a card.

`quote`: optional and short. Use only when wording itself is memorable or technically precise.

## Key ideas

5–12 durable takeaways. These are not chapter titles. They should make sense even if read alone.

## IDs

Use stable, simple IDs:

- `seg-001`, `seg-002`, ... in chronological order
- cluster strings are human-readable labels

Do not use random UUIDs.
