"""Markdown rendering for evaluation reports (kept separate from the runners)."""


def _fmt(v):
    if v is None:
        return "—"
    if isinstance(v, float):
        return f"{v:.4f}".rstrip("0").rstrip(".") if abs(v) < 1000 else f"{v:,.0f}"
    return str(v)


def _table(headers, rows):
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    for r in rows:
        out.append("| " + " | ".join(_fmt(c) for c in r) + " |")
    return "\n".join(out)


def metrics_block(title, s, level=4):
    h = "#" * level
    lines = [f"{h} {title}", "",
             f"{s['n']:,} rows, {s['n_fraud']:,} fraud ({s['fraud_rate']:.3%}). "
             f"**PR-AUC {s['pr_auc']}** (95% CI {s['pr_auc_95ci'][0]}–{s['pr_auc_95ci'][1]}; "
             f"a random ranking would score {s['baseline_pr_auc_if_random']}) · ROC-AUC {s['roc_auc']} · "
             f"Brier {s['brier']} · ECE {s['ece']}", ""]
    lines.append(_table(
        ["Flag if score ≥", "Flagged", "Flag rate", "Precision", "Recall", "False-positive rate", "FP", "FN"],
        [[f"{o['threshold']:.2f}", o["flagged"], f"{o['flag_rate']:.2%}", o["precision"], o["recall"],
          f"{o['false_positive_rate']:.3%}" if o["false_positive_rate"] is not None else None, o["fp"], o["fn"]]
         for o in s["operating_points"]]))
    lines += ["", "Fixed review capacity (analysts can only look at the top X% by score):", ""]
    lines.append(_table(
        ["Review top", "Reviewed", "Precision @ capacity", "Recall @ capacity", "Fraud caught", "Fraud missed"],
        [[f"{c['capacity_frac']:.1%}", c["reviewed"], c["precision_at_capacity"], c["recall_at_capacity"],
          c["fraud_caught"], c["fraud_missed"]] for c in s["review_capacity"]]))
    return "\n".join(lines)


def calibration_block(s):
    return _table(["Predicted bin", "n", "Mean predicted", "Observed fraud rate", "Frauds"],
                  [[c["bin"], c["n"], c["mean_predicted"], c["observed_fraud_rate"], c["fraud_count"]]
                   for c in s["calibration"]])


def _segments(title, segs, kind):
    if not segs:
        return ""
    lines = [f"##### {title}", ""]
    if kind == "feature":
        rows = []
        for name, v in segs.items():
            if "note" in v:
                rows.append([name, v["n"], v["n_fraud"], v["note"], None, None, None])
            else:
                op = v["at_review_threshold"]
                rows.append([name, v["n"], v["n_fraud"], v["pr_auc"], op["precision"], op["recall"], v["at_capacity"]["precision_at_capacity"]])
        lines.append(_table(["Segment", "Rows", "Frauds", "PR-AUC", "Precision @ review thr.", "Recall @ review thr.", "Precision @ 2% capacity"], rows))
    else:
        rows = [[name, v["n_fraud"], v.get("recall_at_review_threshold", v.get("note")), v.get("median_score"), v.get("pr_auc_vs_all_legit")]
                for name, v in segs.items()]
        lines.append(_table(["Fraud type", "Frauds in test", "Recall @ review thr.", "Median score", "PR-AUC vs all legit"], rows))
    return "\n".join(lines) + "\n"


def render_markdown(report):
    out = [f"# Model evaluation — {report['dataset']}", "", f"> **{report['disclaimer']}**", ""]
    out.append(f"Data: `{report.get('data_file', '')}` — {report['n_rows']:,} rows, fraud rate {report['fraud_rate']:.3%}. "
               f"Run time {report.get('runtime_seconds', '?')} s.")
    for name, e in report["experiments"].items():
        out += ["", f"## {name}", ""]
        if "skipped" in e:
            out.append(f"_Skipped: {e['skipped']}_")
            continue
        sp = e["split"]
        out.append(f"**Split:** {sp['split']} — rows {sp['rows']}" + (f", fraud {sp['fraud']}" if "fraud" in sp else ""))
        if sp.get("purged_rows_for_straddling_fraud_episodes"):
            out.append(f"Purged rows (fraud episodes straddling a boundary): {sp['purged_rows_for_straddling_fraud_episodes']}")
        if sp.get("fraud_pattern_counts"):
            out.append(f"Fraud pattern mix per split: {sp['fraud_pattern_counts']}")
        out.append(f"**Model chosen on validation PR-AUC:** {e['model_selected_on_validation']} {e['validation_pr_auc_by_model']}  ")
        out.append(f"**Calibrator:** {e['calibrator']['method']} fitted on {e['calibrator']['n_validation_rows']:,} validation rows "
                   f"({e['calibrator']['n_validation_positives']} frauds).")
        if "new_customer_note" in e:
            out.append(f"\n_{e['new_customer_note']}_")
        if "interpretation" in e:
            out.append(f"\n_{e['interpretation']}_")
        for key in ("test", "test_known_users_in_future", "test_unseen_users", "new_customer_first_3_txns_unseen_users"):
            if key in e:
                out += ["", metrics_block(f"{key.replace('_', ' ')} — calibrated probability", e[key]["calibrated"]), "",
                        f"Raw (uncalibrated) model output on the same rows: PR-AUC {e[key]['raw_model_output']['pr_auc']}, "
                        f"Brier {e[key]['raw_model_output']['brier']}, **ECE {e[key]['raw_model_output']['ece']}** "
                        f"→ after calibration ECE {e[key]['calibrated']['ece']}, Brier {e[key]['calibrated']['brier']}.", "",
                        "Reliability (calibrated):", "", calibration_block(e[key]["calibrated"])]
        if "segments_feature_defined" in e:
            out += ["", _segments("Segments by transaction context", e["segments_feature_defined"], "feature")]
        if "segments_fraud_type" in e:
            out += ["", _segments("Segments by fraud type", e["segments_fraud_type"], "fraud")]
        if "hard_rules_vs_model" in e:
            h = e["hard_rules_vs_model"]
            out += ["", "##### Hard-rule overrides evaluated separately", "", f"_{h['note']}_", "",
                    _table(["Flagging by", "Flagged", "Precision", "Recall", "False positives"],
                           [[k.replace("_", " "), h[k]["flagged"], h[k]["precision"], h[k]["recall"], h[k]["false_positives"]]
                            for k in ("hard_rules_only", "model_only", "model_or_rules")]),
                    "", f"Fraud caught only by rules: {h['fraud_caught_only_by_rules']} · only by the model: {h['fraud_caught_only_by_model']}"]
        if "recommended_thresholds_from_validation" in e:
            r = e["recommended_thresholds_from_validation"]
            out += ["", f"**Proposed thresholds (score units, from validation):** medium ≥ {r['medium']}, high ≥ {r['high']} — {r['basis']}."]
    if report.get("limitations"):
        out += ["", "## Limitations", ""] + [f"- {l}" for l in report["limitations"]]
    return "\n".join(out) + "\n"
