import { z } from "zod";

// Zod 4 otherwise probes for eval with Function("") on first use, which the
// site's content security policy refuses and the browser reports as a violation.
z.config({ jitless: true });
