// R8 convergence guard. Subscribes to the bus, tracks:
//  - tool-call count (budget)
//  - repeat detection: same tool + same args consecutively ≥ N → inject steering
//  - phase regression: moving back to an earlier phase after a later one
//  - budget % (toolCalls / turns / wall-time)
// Exposes observable metrics for the dashboard panel ④.

const PHASE_ORDER = { discover: 0, diagnose: 1, remediate: 2, verify: 3, other: -1 };

export class BudgetGuard {
  constructor({ inject, limits } = {}) {
    this.inject = typeof inject === 'function' ? inject : null;
    this.limits = {
      maxToolCalls: 40,
      maxTurns: 25,
      maxTotalMs: 10 * 60 * 1000,
      maxPerToolMs: { L1: 5000, L2: 30000 },
      repeatThreshold: 3,
      ...(limits || {}),
    };
    this.startedAt = Date.now();
    this.metrics = {
      tool_calls: 0,
      turns: 0,
      repeat_calls: 0,
      phase_regressions: 0,
      max_phase_index: -1,
      budget_pct: 0,
      exceeded: false,
      exceeded_reason: null,
    };
    this._lastRepeatKey = null;
    this._repeatCount = 0;
    this._perToolStart = new Map();
  }

  attach(bus) {
    return bus.on((te) => this._on(te));
  }

  _on(te) {
    if (te.type === 'turn_start') {
      this.metrics.turns++;
    } else if (te.type === 'tool_start') {
      this.metrics.tool_calls++;
      this._checkRepeat(te);
      this._checkPhase(te.phase_hint);
    } else if (te.type === 'tool_end' || te.type === 'tool_error') {
      // per-tool timeout is enforced by the runtime; we observe duration for metrics
    }
    this._updateBudget();
  }

  _checkRepeat(te) {
    const key = `${te.tool_name}::${te.args_summary}`;
    if (key === this._lastRepeatKey) {
      this._repeatCount++;
      if (this._repeatCount >= this.limits.repeatThreshold) {
        this.metrics.repeat_calls++;
        if (this.inject) {
          this.inject(`已连续重复「${te.tool_name}」操作 ${this._repeatCount} 次,请改变策略或结束。`);
        }
        // reset so we don't steer every subsequent identical call
        this._repeatCount = 0;
        this._lastRepeatKey = null;
      }
    } else {
      this._lastRepeatKey = key;
      this._repeatCount = 1;
    }
  }

  _checkPhase(phase) {
    if (!phase) return;
    const idx = PHASE_ORDER[phase] ?? -1;
    if (idx < 0) return;
    if (idx < this.metrics.max_phase_index) {
      this.metrics.phase_regressions++;
    }
    if (idx > this.metrics.max_phase_index) this.metrics.max_phase_index = idx;
  }

  _updateBudget() {
    const elapsed = Date.now() - this.startedAt;
    const f = (n, d) => (d > 0 ? n / d : 0);
    const fracs = [
      f(this.metrics.tool_calls, this.limits.maxToolCalls),
      f(this.metrics.turns, this.limits.maxTurns),
      f(elapsed, this.limits.maxTotalMs),
    ];
    const pct = Math.max(...fracs);
    this.metrics.budget_pct = Math.round(pct * 1000) / 10; // one decimal
    if (pct >= 1 && !this.metrics.exceeded) {
      this.metrics.exceeded = true;
      this.metrics.exceeded_reason = `budget exhausted (calls=${this.metrics.tool_calls}/${this.limits.maxToolCalls}, turns=${this.metrics.turns}/${this.limits.maxTurns}, elapsed=${Math.round(elapsed / 1000)}s/${this.limits.maxTotalMs / 1000}s)`;
    }
  }

  getMetrics() {
    return { ...this.metrics };
  }

  // spec §8 acceptance assertions
  acceptance() {
    return {
      tool_calls_le_15: this.metrics.tool_calls <= 15,
      repeat_le_1: this.metrics.repeat_calls <= 1,
      phase_regressions_le_1: this.metrics.phase_regressions <= 1,
      budget_not_exceeded: !this.metrics.exceeded,
    };
  }
}
