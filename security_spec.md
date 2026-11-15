# ShortForge Security Specification (Phase 0)

## 1. Data Invariants
1. **Strict Ownership Isolation**: Every `VideoJob`, `TopicHistoryEntry`, `AppSettings`, `AutomationConfig`, `AutomationRunLog`, and `UserProfile` belongs strictly to a single verified `ownerUid` matching `request.auth.uid` and the parent `{userId}` path segment.
2. **Email Verification Required**: Standard write operations require `request.auth != null && request.auth.token.email_verified == true`.
3. **Immutable Ownership & Creation Timestamps**: `ownerUid`, `uid`, `id`, and `createdAt` can never be reassigned on updates; `createdAt` must equal `request.time` on creation and `updatedAt` must equal `request.time` on update.
4. **No Self-Assigned Privileges or Ghost Fields**: Every write passes `hasAll` + `hasOnly` key allowlists and strict type/size validation (`isValid*`). No `role`, `isAdmin`, or `plan` fields are accepted.
5. **Terminal State Locking**: Once a `VideoJob` reaches `status == 'completed'`, client writes cannot mutate its `status` or overwrite verified `output`.
6. **Backend Secret Isolation**: `GEMINI_API_KEY`, `PEXELS_API_KEY`, `PIXABAY_API_KEY`, and `SCHEDULER_SECRET` reside strictly on the Node.js server; Cloud Scheduler calls require `X-Scheduler-Secret`, while manual UI triggers require an authenticated user session.

## 2. The "Dirty Dozen" Adversarial Payloads
All 12 payloads below must be rejected (`PERMISSION_DENIED` in Firestore rules and HTTP `401`/`403`/`400` in Express API):

1. **Unauthenticated Read/Write**: Read or write `/users/alice/videos/vid-1` with `auth == null`.
2. **Cross-Tenant Read**: User `bob` reads `/users/alice/videos/vid-1` or `/users/alice`.
3. **Cross-Tenant List Scraping**: User `bob` executes a collection query on `/users/alice/videos`.
4. **Identity Spoofing on Create**: User `bob` creates `/users/bob/videos/vid-2` with `ownerUid: "alice"`.
5. **Owner Hijack on Update**: User `bob` updates `/users/bob/videos/vid-2` attempting to change `ownerUid` to `"alice"`.
6. **Ghost Field / Privilege Escalation**: User `bob` sends `{ ..., isAdmin: true, role: "superadmin" }` on `/users/bob` or `settings`.
7. **Unverified Email Bypass**: Attacker with `email_verified: false` attempts to write `/users/attacker/videos/vid-3`.
8. **ID Poisoning**: Attacker targets `/users/bob/videos/../../etc/passwd` or a 1,500-character document ID.
9. **Denial-of-Wallet String/Array Overflow**: User sends a `topic` of 5,000 chars or `scheduleTimesUtc` with 100 entries.
10. **Terminal State Revert**: User attempts to update a `completed` video back to `status: "draft"` or forge `output`.
11. **Client Timestamp Forgery**: User sends a hardcoded past/future `createdAt` or `updatedAt` instead of `request.time`.
12. **PII Blanket Read**: Signed-in user `bob` attempts `get` on `/users/alice` (contains `email`).
