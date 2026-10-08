import type { HostScheduleObservation, MonitoringRecord } from "@goodfinds/contracts/monitoring";
import { Context } from "effect";

export class HostSchedules extends Context.Service<
  HostSchedules,
  {
    readonly observe: (
      records: MonitoringRecord[],
      now: number,
    ) => Map<string, HostScheduleObservation>;
  }
>()("goodfinds/HostSchedules") {}
