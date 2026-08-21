import { router } from "../init";
import { deviceRouter } from "./device";
import { billingRouter } from "./billing";
import { adminRouter } from "./admin";
import { serversRouter } from "./servers";
import { desktopRouter } from "./desktop";
import { accountRouter } from "./account";
import { analyticsRouter } from "./analytics";
import { transparencyRouter } from "./transparency";

export const appRouter = router({
  device: deviceRouter,
  billing: billingRouter,
  admin: adminRouter,
  servers: serversRouter,
  account: accountRouter,
  desktop: desktopRouter,
  analytics: analyticsRouter,
  transparency: transparencyRouter,
});

export type AppRouter = typeof appRouter;
