# CoLab monthly work-trade summary

This Cloudflare Worker runs at 10:15 UTC on the first day of each month. It reads the previous calendar month from the CoLab activity board, groups member entries by email, and creates or updates one monthly summary per member on the output board.

The supplied monday.com token is intentionally **not** stored in this repository. Because it was shared in the original request, rotate it in monday.com before deployment.

## Policy encoded in the Worker

- Space maintenance (mopping/sweeping, tables, entry table, trash, organizing): 10% per logged activity.
- Retail/inventory: 20%; studio-hours/programming: 25%; event support/grants: 50%; community-event planning and collaboration coordination: 75%.
- Marketing/outreach: 5%; graphics: 10%; sticker-pack rewards: 15%.
- Check-ins and guest passes receive no work-trade reduction. `Other` receives 0 and is explicitly marked for review.
- Contributions are added for the month and capped at 75%.

`Recommended Discount Amount` is a percentage by default, so `20` means 20%. To write a dollar amount instead, set `DISCOUNT_OUTPUT_MODE` to `dollars` and `MEMBERSHIP_MONTHLY_PRICE` to the applicable monthly price. The Worker then caps the dollar discount so at least $10 remains due.

The primary index is `member email` (`text_mm4g8yfa`), with `Email Address` (`email_mkrh6fvx`) used only as a fallback. A summary is upserted by the combination of email and calculation month.

## Configure and deploy

1. Rotate the exposed monday token, then authenticate Wrangler with the Cloudflare account that will own this Worker.
2. Set the replacement token interactively (it is never committed):

   ```sh
   wrangler secret put MONDAY_API_TOKEN
   ```

   Add a second secret to protect the manual-run dashboard:

   ```sh
   wrangler secret put MANUAL_RUN_TOKEN
   ```

3. Review the settings in `wrangler.jsonc`, especially `MEMBER_YES_LABELS`, `APPROVED_STATUS_LABELS`, and the discount output mode. Leave `APPROVED_STATUS_LABELS` blank to include every member activity; use labels such as `Approved,Done` if the status column is an approval gate.
4. Verify and deploy:

   ```sh
   npm test
   npm run deploy
   ```

The `scheduled` handler can be exercised locally with `wrangler dev --test-scheduled`, then requesting `/__scheduled`.

## Manual dashboard

Open the Worker URL in a browser. Choose a calendar month, enter the `MANUAL_RUN_TOKEN` value, and select **Run summary**. The page does not store the run key; it returns the number of activities and members processed when the run finishes.
