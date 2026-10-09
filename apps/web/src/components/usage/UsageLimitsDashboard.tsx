import type { EnvironmentId, ServerProvider, UsageProviderKind } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  collectLimitAccounts,
  collectLimitPools,
  formatDuration,
  type LimitPool,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  ArrowUpRightIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  Clock3Icon,
  LightbulbIcon,
  TerminalIcon,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { useUsageBreakdown } from "../../state/usage";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getDriverOption } from "../settings/providerDriverMeta";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  type ChatShare,
  computeLimitInsights,
  type ForecastStatus,
  formatPoints,
  type HeatmapDay,
  type Insight,
  type LimitInsights,
  mergeBreakdownSessions,
} from "./limitInsights";
import { barColor } from "./UsageLimits";
import { PoolSection, UsageLimitsExtras } from "./UsageLimitsPooled";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function usageKindOf(driver: ServerProvider["driver"]): UsageProviderKind | null {
  if (driver === "claudeAgent") return "claude";
  if (driver === "codex") return "codex";
  if (driver === "grok") return "grok";
  return null;
}

/** Ids of the account-wide weekly window, ahead of model-scoped ones like `seven_day_opus`. */
const MAIN_WEEKLY_IDS = new Set(["seven_day", "secondary", "weekly"]);

/**
 * Categorical slots for projects, light and dark steps of one validated
 * palette. Assigned in fixed order; past six, projects fold into "Other".
 */
const PROJECT_COLORS = [
  "[--project-0:#2a78d6] dark:[--project-0:#3987e5]",
  "[--project-1:#eb6834] dark:[--project-1:#d95926]",
  "[--project-2:#1baf7a] dark:[--project-2:#199e70]",
  "[--project-3:#e87ba4] dark:[--project-3:#d55181]",
  "[--project-4:#4a3aa7] dark:[--project-4:#9085e9]",
  "[--project-5:#eda100] dark:[--project-5:#c98500]",
].join(" ");
const PROJECT_SLOTS = 6;
const projectColor = (index: number) =>
  index < PROJECT_SLOTS ? `var(--project-${index})` : "var(--muted-foreground)";

interface WeeklyTarget {
  readonly driver: ServerProvider["driver"];
  readonly kind: UsageProviderKind;
  readonly label: string;
  readonly window: LimitPoolWindow;
  readonly startMs: number;
  readonly resetsAtMs: number;
}

function weeklyTargetOf(pool: LimitPool): WeeklyTarget | null {
  const kind = usageKindOf(pool.driver);
  if (!kind) return null;
  const weekly = pool.windows.filter((window) => window.kind === "weekly");
  const window = weekly.find((candidate) => MAIN_WEEKLY_IDS.has(candidate.id)) ?? weekly[0];
  if (!window) return null;
  let startMs = Number.POSITIVE_INFINITY;
  let resetsAtMs = 0;
  for (const member of window.members) {
    const resetsAt = member.window.resetsAt ? Date.parse(member.window.resetsAt) : Number.NaN;
    const minutes = member.window.windowDurationMins;
    if (!Number.isFinite(resetsAt) || !minutes) continue;
    startMs = Math.min(startMs, resetsAt - minutes * MINUTE);
    resetsAtMs = Math.max(resetsAtMs, resetsAt);
  }
  if (!Number.isFinite(startMs) || resetsAtMs === 0) return null;
  return {
    driver: pool.driver,
    kind,
    label: getDriverOption(pool.driver)?.label ?? String(pool.driver),
    window,
    startMs,
    resetsAtMs,
  };
}

/**
 * Usage → Limits. The overview answers "can I keep working?" for every
 * provider at once; a provider tab explains that provider's week: the
 * forecast, where it went, and every limit window.
 */
export function UsageLimitsDashboard({
  provider,
  onSelectProvider,
  selectedEnvironmentIds,
  now,
  cursorPrompt,
}: {
  readonly provider: string | null;
  readonly onSelectProvider: (driver: string) => void;
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly now: number;
  readonly cursorPrompt?: ReactNode;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const selected = useMemo(
    () =>
      selectedEnvironmentIds === null
        ? presentations
        : new Map([...presentations].filter(([id]) => selectedEnvironmentIds.has(id))),
    [presentations, selectedEnvironmentIds],
  );
  const pools = useMemo(
    () => collectLimitPools(collectLimitAccounts(selected), now),
    [selected, now],
  );
  // Without a pick, open on the provider closest to running out.
  const pool =
    pools.find((candidate) => candidate.driver === provider) ??
    pools.toSorted((left, right) => remainingOf(left) - remainingOf(right))[0];

  return (
    <div className={cn("flex flex-col gap-10", PROJECT_COLORS)}>
      {pool ? (
        <div className="flex flex-col gap-6">
          {pools.length > 1 ? (
            <ProviderTabs
              pools={pools}
              selectedDriver={pool.driver}
              now={now}
              selectedEnvironmentIds={selectedEnvironmentIds}
              onSelect={onSelectProvider}
            />
          ) : null}
          <ProviderView
            key={pool.driver}
            pool={pool}
            now={now}
            selectedEnvironmentIds={selectedEnvironmentIds}
          />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No provider on the selected environments reports subscription limits.
        </p>
      )}
      <UsageLimitsExtras presentations={selected} cursorPrompt={cursorPrompt} />
    </div>
  );
}

/** Share left in the window the overview leads with: the weekly one when there is one. */
function remainingOf(pool: LimitPool): number {
  return (weeklyTargetOf(pool)?.window ?? pool.windows[0])?.remainingPercent ?? 100;
}

/** The weekly forecast and breakdown for one target; the overview and the provider tab share the query. */
function useWeeklyInsights(
  target: WeeklyTarget | null,
  now: number,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
) {
  // Whole minutes, so re-renders within a refresh share one query.
  const untilMs = target ? Math.min(Math.ceil(now / MINUTE) * MINUTE, target.resetsAtMs) : 0;
  const breakdown = useUsageBreakdown(
    target
      ? {
          provider: target.kind,
          sinceTime: new Date(target.startMs).toISOString(),
          untilTime: new Date(untilMs).toISOString(),
        }
      : null,
    selectedEnvironmentIds,
  );
  const insights = useMemo(
    () =>
      target
        ? computeLimitInsights(
            {
              usedPercent: target.window.usedPercent,
              startMs: target.startMs,
              resetsAtMs: target.resetsAtMs,
              nowMs: now,
            },
            mergeBreakdownSessions(breakdown.answers),
          )
        : null,
    [breakdown.answers, now, target],
  );
  return { insights, isPending: breakdown.isPending && breakdown.answers.length === 0 };
}

/* -------------------------------------------------------------------------- */
/* Provider tabs                                                               */
/* -------------------------------------------------------------------------- */

/** One tab per provider that reports limits, each with its share left and a warning when needed. */
function ProviderTabs({
  pools,
  selectedDriver,
  now,
  selectedEnvironmentIds,
  onSelect,
}: {
  readonly pools: readonly LimitPool[];
  readonly selectedDriver: string;
  readonly now: number;
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly onSelect: (driver: string) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Provider"
      variant="segmented"
      className="self-start"
      value={[selectedDriver]}
      onValueChange={(next) => {
        if (next[0]) onSelect(next[0]);
      }}
    >
      {pools.map((pool) => (
        <ProviderTab
          key={pool.driver}
          pool={pool}
          now={now}
          selectedEnvironmentIds={selectedEnvironmentIds}
        />
      ))}
    </ToggleGroup>
  );
}

function ProviderTab({
  pool,
  now,
  selectedEnvironmentIds,
}: {
  readonly pool: LimitPool;
  readonly now: number;
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
}) {
  const target = useMemo(() => weeklyTargetOf(pool), [pool]);
  const { insights } = useWeeklyInsights(target, now, selectedEnvironmentIds);
  const label = getDriverOption(pool.driver)?.label ?? String(pool.driver);
  const status = insights?.forecast.status;
  const warn = status === "runsOut" || status === "tight";
  return (
    <Toggle value={pool.driver}>
      <ProviderInstanceIcon
        driverKind={pool.driver}
        displayName={label}
        className="size-4"
        iconClassName="size-3.5"
      />
      {label}
      <span className="text-muted-foreground tabular-nums">{remainingOf(pool)}% left</span>
      {warn ? (
        <AlertTriangleIcon
          aria-label={STATUS[status].label}
          className={cn(
            "size-3.5",
            status === "runsOut" ? "text-destructive-foreground" : "text-warning-foreground",
          )}
        />
      ) : null}
    </Toggle>
  );
}

function nextResetIn(window: LimitPoolWindow, now: number): string {
  const next = window.resets[0];
  return next ? `Resets in ${formatDuration(next.at - now)}` : "";
}

/* -------------------------------------------------------------------------- */
/* Provider tab                                                                */
/* -------------------------------------------------------------------------- */

function ProviderView({
  pool,
  now,
  selectedEnvironmentIds,
}: {
  readonly pool: LimitPool;
  readonly now: number;
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
}) {
  const target = useMemo(() => weeklyTargetOf(pool), [pool]);
  // The forecast card already lists every window; the full cards only add
  // something when there are several accounts or reset credits to act on.
  const showWindows =
    !target ||
    pool.accounts.length > 1 ||
    pool.accounts.some((account) => (account.limits.resetCredits?.availableCount ?? 0) > 0);
  return (
    <div className="flex flex-col gap-10">
      {target ? (
        <WeeklyLimitView
          pool={pool}
          target={target}
          now={now}
          selectedEnvironmentIds={selectedEnvironmentIds}
        />
      ) : null}
      {showWindows ? (
        <section className="flex flex-col gap-4">
          <SectionHeading title={target ? "Accounts and reset credits" : "Limit windows"} />
          <PoolSection pool={pool} now={now} showHeading={false} />
        </section>
      ) : null}
    </div>
  );
}

function SectionHeading({
  title,
  detail,
}: {
  readonly title: string;
  readonly detail?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {detail ? <p className="max-w-2xl text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

function Card({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0 rounded-xl border border-border/70 bg-card p-5", className)}>
      {children}
    </div>
  );
}

function CardTitle({
  children,
  aside,
}: {
  readonly children: ReactNode;
  readonly aside?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-3">
      <h3 className="text-sm font-medium text-foreground">{children}</h3>
      {aside ? <span className="text-xs text-muted-foreground tabular-nums">{aside}</span> : null}
    </div>
  );
}

function WeeklyLimitView({
  pool,
  target,
  now,
  selectedEnvironmentIds,
}: {
  readonly pool: LimitPool;
  readonly target: WeeklyTarget;
  readonly now: number;
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
}) {
  const { insights, isPending } = useWeeklyInsights(target, now, selectedEnvironmentIds);
  if (!insights) return null;
  const color = barColor(target.driver);

  return (
    <>
      <section className="flex flex-col gap-4">
        <ForecastCard pool={pool} target={target} insights={insights} color={color} now={now} />
      </section>
      <section className="flex flex-col gap-4">
        <SectionHeading
          title="Where it went"
          detail={
            <>
              Estimated since the week started {formatWeekday(target.startMs)}. Each chat's share of
              this week's API-equivalent cost is applied to the {target.window.usedPercent}% you
              have used. Usage from other computers or the web app is not visible here.
            </>
          }
        />
        {isPending ? (
          <WhereItWentSkeleton />
        ) : insights.chats.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">
              No {target.label} usage found on the selected environments since the week started.
              {target.window.usedPercent > 0
                ? " What you have used so far came from somewhere else, such as another computer or the web app."
                : ""}
            </p>
          </Card>
        ) : (
          <WhereItWent insights={insights} color={color} now={now} />
        )}
      </section>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Forecast                                                                    */
/* -------------------------------------------------------------------------- */

const STATUS: Record<
  ForecastStatus,
  {
    readonly label: string;
    readonly variant: "info" | "success" | "warning" | "error";
    readonly icon: typeof CheckCircle2Icon;
  }
> = {
  early: { label: "Early in the week", variant: "info", icon: Clock3Icon },
  onTrack: { label: "On track", variant: "success", icon: CheckCircle2Icon },
  tight: { label: "Cutting it close", variant: "warning", icon: CircleAlertIcon },
  runsOut: { label: "Will run out early", variant: "error", icon: AlertTriangleIcon },
};

/** The forecast in one sentence, shared by the overview card and the provider tab. */
function ForecastSentence({
  target,
  insights,
  now,
}: {
  readonly target: WeeklyTarget;
  readonly insights: LimitInsights;
  readonly now: number;
}) {
  const { forecast } = insights;
  if (forecast.status === "early") {
    return (
      <>
        <strong className="font-semibold text-foreground">{target.window.usedPercent}% used</strong>{" "}
        in the first {formatDuration(now - target.startMs)}. Too early to call a trend; spread
        evenly, the rest allows about {formatPoints(forecast.dailyBudget)} a day.
      </>
    );
  }
  if (forecast.runsOutAtMs !== null) {
    return (
      <>
        At this pace you will run out{" "}
        <strong className="font-semibold text-foreground">
          {formatWeekdayTime(forecast.runsOutAtMs)}
        </strong>
        , {formatDuration(target.resetsAtMs - forecast.runsOutAtMs)} before it resets.
      </>
    );
  }
  return (
    <>
      At this pace you will finish the week with about{" "}
      <strong className="font-semibold text-foreground">
        {Math.max(0, Math.round(100 - forecast.projectedUsedAtReset))}% left
      </strong>
      .
    </>
  );
}

function ForecastCard({
  pool,
  target,
  insights,
  color,
  now,
}: {
  readonly pool: LimitPool;
  readonly target: WeeklyTarget;
  readonly insights: LimitInsights;
  readonly color: string;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const { forecast } = insights;
  const status = STATUS[forecast.status];
  const StatusIcon = status.icon;
  const headline = <ForecastSentence target={target} insights={insights} now={now} />;
  const otherWindows = pool.windows.filter((window) => window !== target.window);

  return (
    <Card className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ProviderInstanceIcon
              driverKind={target.driver}
              displayName={target.label}
              className="size-5"
              iconClassName="size-4 text-foreground/80"
            />
            <span className="font-medium text-foreground">{target.label} weekly limit</span>
            <span aria-hidden>·</span>
            <span>
              Resets{" "}
              {formatUpcomingTimestamp(
                new Date(target.resetsAtMs).toISOString(),
                timestampFormat,
                now,
              )}
            </span>
          </div>
          <div className="flex items-baseline gap-3">
            <span className="text-5xl font-semibold tracking-tight text-foreground tabular-nums">
              {target.window.remainingPercent}%
            </span>
            <span className="text-base text-muted-foreground">left this week</span>
          </div>
          <p className="max-w-xl text-sm text-muted-foreground">{headline}</p>
        </div>
        <div className="flex w-full flex-col gap-4 md:w-64">
          <Badge variant={status.variant} size="lg" className="self-start md:self-end">
            <StatusIcon aria-hidden />
            {status.label}
          </Badge>
          {otherWindows.length > 0 ? (
            <ul className="flex flex-col gap-2.5 rounded-lg bg-muted/50 p-3">
              {otherWindows.map((window) => (
                <li key={`${window.kind}:${window.id}`} className="flex flex-col gap-1">
                  <div className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="truncate text-muted-foreground">{window.label}</span>
                    <span className="font-medium text-foreground tabular-nums">
                      {window.remainingPercent}% left
                    </span>
                  </div>
                  <div className="h-1 rounded-full bg-muted">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${window.remainingPercent}%`, backgroundColor: color }}
                    />
                  </div>
                  <span className="text-2xs text-muted-foreground tabular-nums">
                    {nextResetIn(window, now)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      <BurnChart target={target} insights={insights} color={color} now={now} />

      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border/60 pt-5 md:grid-cols-4">
        <Stat label="Used today" value={`≈${formatPoints(forecast.today)}`} />
        <Stat
          label="Last 24 hours"
          value={forecast.last24h === null ? "—" : `≈${formatPoints(forecast.last24h)}`}
        />
        <Stat label="Average per day" value={formatPoints(forecast.averagePerDay)} />
        <Stat label="Daily budget to reset" value={formatPoints(forecast.dailyBudget)} />
      </dl>
    </Card>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold text-foreground tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * Share of the weekly limit used, from the window's start to its reset: the
 * filled line is what happened, the dashed diagonal is even spending, and the
 * dashed continuation is where the current pace lands.
 */
function BurnChart({
  target,
  insights,
  color,
  now,
}: {
  readonly target: WeeklyTarget;
  readonly insights: LimitInsights;
  readonly color: string;
  readonly now: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const { startMs, resetsAtMs } = target;
  const span = resetsAtMs - startMs;
  const x = (ms: number) => ((ms - startMs) / span) * 1000;
  const y = (used: number) => 100 - Math.max(0, Math.min(100, used));
  const used = target.window.usedPercent;
  const { forecast } = insights;

  // Scale the seen usage so the line ends on the reported share; usage the
  // transcripts did not see is spread in proportion rather than dropped.
  const seen = insights.cumulative.at(-1)?.used ?? 0;
  const scale = seen > 0 ? used / seen : 0;
  const points = insights.cumulative.map((point) => ({ ...point, used: point.used * scale }));
  const line = points
    .map((point) => `${x(point.atMs).toFixed(2)},${y(point.used).toFixed(2)}`)
    .join(" L");
  const area = `M${x(startMs)},100 L${line} L${x(now).toFixed(2)},100 Z`;
  const projectionEnd =
    forecast.runsOutAtMs !== null
      ? { atMs: forecast.runsOutAtMs, used: 100 }
      : { atMs: resetsAtMs, used: forecast.projectedUsedAtReset };

  const days: number[] = [];
  const firstMidnight = new Date(startMs);
  firstMidnight.setHours(24, 0, 0, 0);
  for (let day = firstMidnight.getTime(); day < resetsAtMs;) {
    days.push(day);
    const next = new Date(day);
    next.setDate(next.getDate() + 1);
    day = next.getTime();
  }

  const hoverMs = hover === null ? null : startMs + hover * span;
  const hoverUsed =
    hoverMs === null
      ? null
      : hoverMs <= now
        ? (points.toReversed().find((point) => point.atMs <= hoverMs)?.used ?? 0)
        : Math.min(100, used + forecast.ratePerHour * ((hoverMs - now) / HOUR));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <LegendSwatch color={color}>Used so far</LegendSwatch>
        {forecast.status === "early" ? null : (
          <LegendSwatch color={color} dashed>
            At this pace
          </LegendSwatch>
        )}
        <LegendSwatch color="var(--muted-foreground)" dashed>
          Even pace
        </LegendSwatch>
      </div>
      <div className="relative grid grid-cols-[2.5rem_minmax(0,1fr)]">
        <div className="relative h-44 text-2xs text-muted-foreground tabular-nums">
          {[100, 50, 0].map((tick) => (
            <span
              key={tick}
              className="absolute right-2 -translate-y-1/2"
              style={{ top: `${100 - tick}%` }}
            >
              {tick}%
            </span>
          ))}
        </div>
        <div
          className="relative h-44 cursor-crosshair"
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setHover(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)));
          }}
          onPointerLeave={() => setHover(null)}
        >
          <svg
            viewBox="0 0 1000 100"
            preserveAspectRatio="none"
            className="absolute inset-0 size-full overflow-visible"
            role="img"
            aria-label={`${used}% of the weekly limit used so far`}
          >
            {[25, 50, 75].map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={1000}
                y1={tick}
                y2={tick}
                stroke="var(--border)"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <line
              x1={0}
              x2={1000}
              y1={0}
              y2={0}
              stroke="var(--muted-foreground)"
              strokeOpacity={0.5}
              strokeDasharray="2 3"
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={0}
              x2={1000}
              y1={100}
              y2={100}
              stroke="var(--border)"
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={0}
              y1={100}
              x2={1000}
              y2={0}
              stroke="var(--muted-foreground)"
              strokeOpacity={0.6}
              strokeWidth={1.5}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
            <path d={area} fill={color} fillOpacity={0.14} />
            <path
              d={`M${line}`}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            {forecast.status === "early" ? null : (
              <line
                x1={x(now)}
                y1={y(used)}
                x2={x(projectionEnd.atMs)}
                y2={y(projectionEnd.used)}
                stroke={color}
                strokeWidth={2}
                strokeDasharray="5 4"
                vectorEffect="non-scaling-stroke"
              />
            )}
            <line
              x1={x(now)}
              x2={x(now)}
              y1={0}
              y2={100}
              stroke="var(--foreground)"
              strokeOpacity={0.25}
              vectorEffect="non-scaling-stroke"
            />
            {hover !== null ? (
              <line
                x1={hover * 1000}
                x2={hover * 1000}
                y1={0}
                y2={100}
                stroke="var(--foreground)"
                strokeOpacity={0.4}
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>
          <span
            aria-hidden
            className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card"
            style={{ left: `${x(now) / 10}%`, top: `${y(used)}%`, backgroundColor: color }}
          />
          {forecast.runsOutAtMs !== null && forecast.status === "runsOut" ? (
            <span
              aria-hidden
              className={cn(
                "absolute -translate-y-full pb-1 text-2xs font-medium whitespace-nowrap text-destructive-foreground",
                x(forecast.runsOutAtMs) > 850 ? "-translate-x-full" : "-translate-x-1/2",
              )}
              style={{ left: `${x(forecast.runsOutAtMs) / 10}%`, top: 0 }}
            >
              Runs out {formatWeekdayTime(forecast.runsOutAtMs)}
            </span>
          ) : null}
          {hoverMs !== null && hoverUsed !== null && hover !== null ? (
            <div
              className={cn(
                "pointer-events-none absolute top-2 z-10 rounded-md border border-border/70 bg-popover px-2.5 py-1.5 text-xs shadow-md",
                hover > 0.6 ? "-translate-x-[calc(100%+8px)]" : "translate-x-2",
              )}
              style={{ left: `${hover * 100}%` }}
            >
              <div className="font-medium text-foreground">{formatWeekdayTime(hoverMs)}</div>
              <div className="text-muted-foreground tabular-nums">
                {hoverMs <= now ? "Used" : "Projected"} {Math.round(hoverUsed)}% · even pace{" "}
                {Math.round(((hoverMs - startMs) / span) * 100)}%
              </div>
            </div>
          ) : null}
        </div>
        <div />
        <div className="relative mt-1.5 h-4 text-2xs text-muted-foreground">
          {days.map((day) => (
            <span
              key={day}
              className="absolute -translate-x-1/2 whitespace-nowrap"
              style={{ left: `${x(day) / 10}%` }}
            >
              {new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(day)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function LegendSwatch({
  color,
  dashed = false,
  children,
}: {
  readonly color: string;
  readonly dashed?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg aria-hidden width="16" height="4" className="shrink-0">
        <line
          x1="0"
          x2="16"
          y1="2"
          y2="2"
          stroke={color}
          strokeWidth="2"
          strokeDasharray={dashed ? "4 3" : undefined}
        />
      </svg>
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Where it went                                                               */
/* -------------------------------------------------------------------------- */

function WhereItWent({
  insights,
  color,
  now,
}: {
  readonly insights: LimitInsights;
  readonly color: string;
  readonly now: number;
}) {
  return (
    <div className="flex flex-col gap-4">
      {insights.insights.length > 0 ? <Insights insights={insights.insights} /> : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <ProjectsCard insights={insights} />
        <ModelsCard insights={insights} color={color} />
      </div>
      <ChatsCard insights={insights} color={color} now={now} />
      <HeatmapCard insights={insights} color={color} now={now} />
    </div>
  );
}

function Insights({ insights }: { readonly insights: readonly Insight[] }) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col gap-3">
      {insights.map((insight) => {
        const Icon = insight.tone === "warning" ? AlertTriangleIcon : LightbulbIcon;
        const session = insight.session;
        return (
          <div
            key={insight.id}
            className={cn(
              "flex gap-3 rounded-xl border p-4",
              insight.tone === "warning"
                ? "border-warning/30 bg-warning-surface"
                : "border-border/70 bg-card",
            )}
          >
            <Icon
              aria-hidden
              className={cn(
                "mt-0.5 size-4 shrink-0",
                insight.tone === "warning" ? "text-warning-foreground" : "text-muted-foreground",
              )}
            />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-sm font-medium text-foreground">{insight.title}</p>
              <p className="text-xs text-muted-foreground">{insight.body}</p>
              {session?.threadId ? (
                <Button
                  size="xs"
                  variant="outline"
                  className="mt-1.5 w-fit"
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: { environmentId: session.environmentId, threadId: session.threadId! },
                    })
                  }
                >
                  Open chat
                  <ArrowUpRightIcon aria-hidden />
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ProjectsCard({ insights }: { readonly insights: LimitInsights }) {
  const shown = insights.projects.slice(0, PROJECT_SLOTS);
  const rest = insights.projects.slice(PROJECT_SLOTS);
  const rows = [
    ...shown.map((project, index) => ({ ...project, color: projectColor(index) })),
    ...(rest.length > 0
      ? [
          {
            key: "other",
            label: `${rest.length} more`,
            points: rest.reduce((sum, project) => sum + project.points, 0),
            share: rest.reduce((sum, project) => sum + project.share, 0),
            chats: rest.reduce((sum, project) => sum + project.chats, 0),
            color: projectColor(PROJECT_SLOTS),
          },
        ]
      : []),
  ];
  const total = rows.reduce((sum, row) => sum + row.points, 0);
  return (
    <Card>
      <CardTitle
        aside={`${insights.projects.length} ${insights.projects.length === 1 ? "project" : "projects"}`}
      >
        By project
      </CardTitle>
      <div
        className="mb-5 flex h-3 w-full gap-0.5 overflow-hidden rounded-full"
        role="img"
        aria-label="Share of the limit by project"
      >
        {rows.map((row) => (
          <div
            key={row.key}
            className="h-full first:rounded-s-full last:rounded-e-full"
            style={{ width: `${(row.points / total) * 100}%`, backgroundColor: row.color }}
          />
        ))}
      </div>
      <ul className="flex flex-col gap-2.5">
        {rows.map((row) => (
          <li
            key={row.key}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 text-sm"
          >
            <span
              aria-hidden
              className="size-2.5 rounded-full"
              style={{ backgroundColor: row.color }}
            />
            <span className="truncate text-foreground">{row.label}</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {row.chats} {row.chats === 1 ? "chat" : "chats"}
            </span>
            <span className="w-14 text-end font-medium text-foreground tabular-nums">
              ≈{formatPoints(row.points)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ModelsCard({
  insights,
  color,
}: {
  readonly insights: LimitInsights;
  readonly color: string;
}) {
  const max = insights.models[0]?.points ?? 0;
  return (
    <Card>
      <CardTitle>By model</CardTitle>
      <ul className="flex flex-col gap-3.5">
        {insights.models.slice(0, 6).map((model) => (
          <li key={model.label} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate text-foreground">{model.label}</span>
              <span className="font-medium text-foreground tabular-nums">
                ≈{formatPoints(model.points)}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-muted">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${max > 0 ? (model.points / max) * 100 : 0}%`,
                  backgroundColor: color,
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const CHATS_PREVIEW = 8;

function ChatsCard({
  insights,
  color,
  now,
}: {
  readonly insights: LimitInsights;
  readonly color: string;
  readonly now: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const chats = expanded ? insights.chats : insights.chats.slice(0, CHATS_PREVIEW);
  const max = insights.chats[0]?.points ?? 0;
  const projectIndex = new Map(insights.projects.map((project, index) => [project.label, index]));
  return (
    <Card className="px-2 pb-2">
      <div className="px-3">
        <CardTitle
          aside={`${insights.chats.length} ${insights.chats.length === 1 ? "chat" : "chats"} this week`}
        >
          Chats that used the most
        </CardTitle>
      </div>
      <ol className="flex flex-col">
        {chats.map((chat, index) => (
          <ChatRow
            key={chat.key}
            chat={chat}
            rank={index + 1}
            max={max}
            color={color}
            projectColor={projectColor(
              Math.min(projectIndex.get(chat.projectLabel) ?? PROJECT_SLOTS, PROJECT_SLOTS),
            )}
            now={now}
          />
        ))}
      </ol>
      {insights.chats.length > CHATS_PREVIEW ? (
        <div className="px-3 pt-1">
          <Button size="xs" variant="ghost" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Show fewer" : `Show all ${insights.chats.length}`}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function ChatRow({
  chat,
  rank,
  max,
  color,
  projectColor: dotColor,
  now,
}: {
  readonly chat: ChatShare;
  readonly rank: number;
  readonly max: number;
  readonly color: string;
  readonly projectColor: string;
  readonly now: number;
}) {
  const navigate = useNavigate();
  const threadId = chat.session.threadId;
  const content = (
    <>
      <span className="w-5 shrink-0 text-end text-xs text-muted-foreground tabular-nums">
        {rank}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{chat.title}</span>
          {chat.outsideT3 ? (
            <Badge variant="outline" size="sm">
              <TerminalIcon aria-hidden />
              {chat.origin ?? "Outside T3"}
            </Badge>
          ) : null}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: dotColor }}
          />
          <span className="truncate">{chat.projectLabel}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0 tabular-nums">
            {chat.responses} {chat.responses === 1 ? "reply" : "replies"}
          </span>
          {chat.models.length > 0 ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{chat.models.join(", ")}</span>
            </>
          ) : null}
        </span>
      </span>
      <span className="hidden w-40 shrink-0 sm:block">
        <span className="block h-1.5 rounded-full bg-muted">
          <span
            className="block h-full rounded-full"
            style={{
              width: `${max > 0 ? Math.max(2, (chat.points / max) * 100) : 0}%`,
              backgroundColor: color,
            }}
          />
        </span>
      </span>
      <span className="w-14 shrink-0 text-end text-sm font-semibold text-foreground tabular-nums">
        ≈{formatPoints(chat.points)}
      </span>
      <span className="hidden w-16 shrink-0 text-end text-xs text-muted-foreground tabular-nums md:block">
        {formatAgo(now - chat.lastActiveMs)}
      </span>
    </>
  );
  const className = "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-start";
  return (
    <li>
      {threadId ? (
        <button
          type="button"
          className={cn(
            className,
            "cursor-pointer outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
          )}
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: chat.session.environmentId, threadId },
            })
          }
        >
          {content}
        </button>
      ) : (
        <div className={className}>{content}</div>
      )}
    </li>
  );
}

function HeatmapCard({
  insights,
  color,
  now,
}: {
  readonly insights: LimitInsights;
  readonly color: string;
  readonly now: number;
}) {
  const [hover, setHover] = useState<{ day: HeatmapDay; hour: number } | null>(null);
  const busiest = insights.heatmap.reduce<HeatmapDay | null>(
    (best, day) => (best === null || day.points > best.points ? day : best),
    null,
  );
  const max = insights.maxHourPoints;
  const caption = hover
    ? `${formatWeekday(hover.day.dayStartMs)}, ${formatHourRange(hover.day.hours[hover.hour]!.startMs)} · ≈${formatPoints(hover.day.hours[hover.hour]!.points)}`
    : busiest && busiest.points > 0
      ? `Busiest day: ${formatWeekday(busiest.dayStartMs)}, ≈${formatPoints(busiest.points)}`
      : "";
  return (
    <Card>
      <CardTitle aside={caption}>When you used it</CardTitle>
      <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_3.5rem] items-center gap-x-3 gap-y-1">
        <span />
        <div className="grid grid-cols-24 text-2xs text-muted-foreground">
          {Array.from({ length: 24 }, (_, hour) => (
            <span key={hour} className="col-span-1 text-start">
              {hour % 6 === 0 ? formatHourLabel(hour) : ""}
            </span>
          ))}
        </div>
        <span />
        {insights.heatmap.map((day) => (
          <HeatmapRow
            key={day.dayStartMs}
            day={day}
            max={max}
            color={color}
            now={now}
            onHover={(hour) => setHover(hour === null ? null : { day, hour })}
          />
        ))}
      </div>
    </Card>
  );
}

function HeatmapRow({
  day,
  max,
  color,
  now,
  onHover,
}: {
  readonly day: HeatmapDay;
  readonly max: number;
  readonly color: string;
  readonly now: number;
  readonly onHover: (hour: number | null) => void;
}) {
  return (
    <>
      <span className="text-xs whitespace-nowrap text-muted-foreground">
        {new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" }).format(
          day.dayStartMs,
        )}
      </span>
      <div className="grid grid-cols-24 gap-0.5" onPointerLeave={() => onHover(null)}>
        {day.hours.map((hour, index) => {
          const future = hour.startMs >= now;
          const intensity =
            max > 0 && hour.points > 0 ? 0.15 + 0.85 * Math.sqrt(hour.points / max) : 0;
          return (
            <span
              key={hour.startMs}
              onPointerEnter={() => onHover(index)}
              className={cn(
                "h-5 rounded-xs",
                intensity === 0 && (future ? "bg-muted/40" : "bg-muted"),
              )}
              style={intensity > 0 ? { backgroundColor: color, opacity: intensity } : undefined}
            />
          );
        })}
      </div>
      <span className="text-end text-xs font-medium text-foreground tabular-nums">
        {day.future || day.points === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          `≈${formatPoints(day.points)}`
        )}
      </span>
    </>
  );
}

function WhereItWentSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
      </div>
      <Skeleton className="h-80" />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

function formatWeekday(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(ms);
}

function formatWeekdayTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(ms);
}

function formatHourLabel(hour: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(new Date(2000, 0, 1, hour));
}

function formatHourRange(startMs: number): string {
  const format = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
  return `${format.format(startMs)}–${format.format(startMs + HOUR)}`;
}

function formatAgo(ms: number): string {
  if (ms < HOUR) return "just now";
  if (ms < 24 * HOUR) return `${Math.floor(ms / HOUR)}h ago`;
  return `${Math.floor(ms / (24 * HOUR))}d ago`;
}
