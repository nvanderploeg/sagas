import { setAccessEnforced } from '../domain/access.ts';

// Most specs act as an arbitrary User on any Realm; the access specs turn enforcement back on.
setAccessEnforced(false);

// A deprecation notice from pg, such as two statements at once on one client, fails the spec.
process.throwDeprecation = true;
