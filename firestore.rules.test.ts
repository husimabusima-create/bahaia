/**
 * Verification matrix for ShortForge Firestore Security Rules ("Dirty Dozen" Red Team Suite).
 * Evaluates all 12 adversarial payloads from security_spec.md against firestore.rules.
 */

export interface SecurityTestCase {
  id: number;
  name: string;
  actorUid: string | null;
  emailVerified: boolean;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_CASES: SecurityTestCase[] = [
  {
    id: 1,
    name: 'Unauthenticated read on user video',
    actorUid: null,
    emailVerified: false,
    operation: 'get',
    path: '/users/alice-uid/videos/vid-001',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Cross-tenant get on another user profile/video',
    actorUid: 'bob-uid',
    emailVerified: true,
    operation: 'get',
    path: '/users/alice-uid/videos/vid-001',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Cross-tenant collection list scraping',
    actorUid: 'bob-uid',
    emailVerified: true,
    operation: 'list',
    path: '/users/alice-uid/videos',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Identity spoofing via mismatched ownerUid on create',
    actorUid: 'bob-uid',
    emailVerified: true,
    operation: 'create',
    path: '/users/bob-uid/videos/vid-002',
    payload: { id: 'vid-002', ownerUid: 'alice-uid', topic: 'Test topic' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Owner hijack attempt on update',
    actorUid: 'bob-uid',
    emailVerified: true,
    operation: 'update',
    path: '/users/bob-uid/videos/vid-002',
    payload: { ownerUid: 'alice-uid' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Ghost field privilege escalation (isAdmin / role)',
    actorUid: 'bob-uid',
    emailVerified: true,
    operation: 'create',
    path: '/users/bob-uid',
    payload: { uid: 'bob-uid', email: 'bob@example.com', isAdmin: true, role: 'superadmin' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Unverified email write bypass attempt',
    actorUid: 'bob-uid',
    emailVerified: false,
    operation: 'create',
    path: '/users/bob-uid/videos/vid-003',
    payload: { id: 'vid-003', ownerUid: 'bob-uid', topic: 'Valid topic' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'ID poisoning with invalid characters or excessive length',
    actorUid: 'bob-uid',
    emailVerified: true,
    operation: 'create',
    path: '/users/bob-uid/videos/' + 'a'.repeat(300),
    payload: { id: 'a'.repeat(300), ownerUid: 'bob-uid' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Denial-of-wallet string/array overflow on topic/schedule',
    actorUid: 'bob-uid',
    emailVerified: true,
    operation: 'create',
    path: '/users/bob-uid/videos/vid-004',
    payload: { id: 'vid-004', ownerUid: 'bob-uid', topic: 'x'.repeat(2000) },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Terminal state revert on completed video',
    actorUid: 'bob-uid',
    emailVerified: true,
    operation: 'update',
    path: '/users/bob-uid/videos/vid-completed',
    payload: { status: 'draft' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Client timestamp forgery instead of request.time',
    actorUid: 'bob-uid',
    emailVerified: true,
    operation: 'create',
    path: '/users/bob-uid/settings/default',
    payload: { ownerUid: 'bob-uid', updatedAt: '2020-01-01T00:00:00Z' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'PII blanket list on /users collection',
    actorUid: 'bob-uid',
    emailVerified: true,
    operation: 'list',
    path: '/users',
    expected: 'PERMISSION_DENIED',
  },
];
