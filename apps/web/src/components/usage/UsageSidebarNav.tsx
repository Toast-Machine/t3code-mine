import { ChartNoAxesColumnIcon, CoinsIcon, GaugeIcon } from "lucide-react";
import { useNavigate, useSearch } from "@tanstack/react-router";

import { PageSidebarNav } from "../sidebar/PageSidebarNav";
import { readUsagePagePreferences } from "./usagePagePreferences";
import { METRIC_OPTIONS, type UsageMetric } from "./usageShortcuts";

const METRIC_ICONS = {
  cost: CoinsIcon,
  tokens: ChartNoAxesColumnIcon,
  limits: GaugeIcon,
} as const satisfies Record<UsageMetric, unknown>;

// The Usage page's views; the selected one lives in the URL (?metric=).
export function UsageSidebarNav() {
  const navigate = useNavigate();
  const metric = useSearch({ from: "/usage" }).metric ?? readUsagePagePreferences().metric;
  return (
    <PageSidebarNav
      sections={[
        {
          items: METRIC_OPTIONS.map((option) => ({
            id: option.value,
            label: option.label,
            icon: METRIC_ICONS[option.value],
            active: metric === option.value,
            onSelect: () => void navigate({ to: "/usage", search: { metric: option.value } }),
          })),
        },
      ]}
    />
  );
}
