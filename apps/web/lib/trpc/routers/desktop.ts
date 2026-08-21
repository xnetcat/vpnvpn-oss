import { z } from "zod";
import { router, publicProcedure } from "../init";
import { rateLimit } from "../rateLimit";
import { consumeDesktopCode } from "@/lib/desktopCodes";

export const desktopRouter = router({
  // Resolve a 6-digit desktop login code to the original NextAuth callback URL.
  // Returns { ok: true, url } on success or { ok: false } when the code is
  // invalid or expired. Public procedure → rate-limited by client IP.
  resolveCode: publicProcedure
    .use(rateLimit({ name: "desktop.resolveCode", limit: 10 }))
    .input(
      z.object({
        email: z.string().email(),
        code: z.string().min(6).max(6),
      }),
    )
    .mutation(async ({ input }) => {
      const url = await consumeDesktopCode(input.email, input.code);
      if (!url) {
        return { ok: false as const };
      }
      return { ok: true as const, url };
    }),
});
