---
name: Hermes training priority
description: Defines how active autonomous training and queued viewer comments are ordered.
---

Once Hermes starts a bounded training task, let the entire task settle before interpreting or leasing queued viewer comments. Continue ingesting and displaying comments immediately, tell viewers that Hermes will reply after the current task, and preserve FIFO order.

**Why:** The user explicitly chose uninterrupted task completion over viewer preemption so Hermes can finish execution, observation, lesson persistence, validation, activation, or rollback without changing context halfway through.

**How to apply:** Treat training admission and viewer interpretation/lease transitions as one serialized boundary. Viewer activity postpones future training but does not cancel active training. Keep hard safety limits, and never start a new training task while viewer work is pending.