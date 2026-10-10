import { ENGINE_VERSION, runAnalysis } from "@/lib/physics/analysis";
import type { SavedAnalysis } from "@/lib/persistence/schema";

/**
 * For records from outside this browser (imports): recompute with the current engine and check
 * that the stored headline results really follow from the stored inputs. Returns null when the
 * record was made by a different engine version (it is then shown as a historical snapshot).
 */
export function verifyRecord(record: SavedAnalysis): boolean | null {
  if (record.engineVersion !== ENGINE_VERSION) return null;
  try {
    const fresh = runAnalysis(record.result.config);
    const close = (a: number | null | undefined, b: number | null | undefined) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)));
    const same = (x: typeof fresh.stock | null, y: typeof fresh.stock | null) =>
      (!x && !y) ||
      (!!x && !!y && close(x.metrics.zeroTo60S, y.metrics.zeroTo60S) && close(x.metrics.quarterMileS, y.metrics.quarterMileS) && close(x.metrics.topSpeedMs, y.metrics.topSpeedMs));
    return same(fresh.stock, record.result.stock) && same(fresh.modified, record.result.modified) && fresh.feasibility.stock.status === record.result.feasibility.stock.status;
  } catch {
    return false;
  }
}
