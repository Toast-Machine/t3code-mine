import { CoinsIcon, GaugeIcon } from "lucide-react";
import { useNavigate, useSearch } from "@tanstack/react-router";

import { PageSidebarNav } from "../sidebar/PageSidebarNav";
import { readUsagePagePreferences } from "./usagePagePreferences";

// The Usage page's two views: Limits (what is left) and Spend (API-equivalent
// cost and tokens). The selection lives in the URL (?metric=).
export function UsageSidebarNav() {
  const navigate = useNavigate();
  // Not required to match: the sidebar can render a frame apart from the page.
  const saved = readUsagePagePreferences();
  const metric = useSearch({ from: "/usage", shouldThrow: false })?.metric ?? saved.metric;
  const onLimits = metric === "limits";
  return (
    <PageSidebarNav
      sections={[
        {
          items: [
            {
              id: "limits",
              label: "Limits",
              icon: GaugeIcon,
              active: onLimits,
              onSelect: () => void navigate({ to: "/usage", search: { metric: "limits" } }),
            },
            {
              id: "spend",
              label: "Spend",
              icon: CoinsIcon,
              active: !onLimits,
              onSelect: () =>
                void navigate({ to: "/usage", search: { metric: saved.spendMetric ?? "cost" } }),
            },
          ],
        },
      ]}
    />
  );
}
