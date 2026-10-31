"""
Leakage-safe splits for transaction data.

A plain random split of per-user, time-ordered transactions leaks in three
ways, all of which inflate scores:

  1. TIME   - the model trains on the future of the very period it is tested on.
  2. USER   - the same customer (their device, home city, spending habit) is in
              both train and test, so "is this a known-good user?" is memorised.
  3. EPISODE- one fraud incident (a burst of card-testing, one takeover) is cut
              in half: the first transactions train the model, the last are
              "predicted" in test.

So:  chronological_split()  fixes (1) and PURGES training rows belonging to
an episode that crosses a boundary (3);  user_disjoint_mask() fixes (2) for
the "brand-new customer" test.
"""

import numpy as np
import pandas as pd

EPISODE_GAP_HOURS = 24


def assign_episodes(df, user_col="user_synthetic_id", ts_col="timestamp", label_col="is_fraud",
                    gap_hours=EPISODE_GAP_HOURS):
    """Groups each user's fraud transactions into incidents: consecutive
    frauds of the same user less than `gap_hours` apart are one episode.
    Returns a Series of integer episode ids (-1 for legit rows)."""
    ts = pd.to_datetime(df[ts_col], format="ISO8601")
    ep = pd.Series(-1, index=df.index, dtype=int)
    fraud = df[df[label_col] == 1].assign(_ts=ts[df[label_col] == 1]).sort_values([user_col, "_ts"])
    prev_user, prev_ts, ep_id = None, None, -1
    for idx, row in fraud.iterrows():
        new = prev_user != row[user_col] or (row["_ts"] - prev_ts) > pd.Timedelta(hours=gap_hours)
        if new:
            ep_id += 1
        ep.at[idx] = ep_id
        prev_user, prev_ts = row[user_col], row["_ts"]
    return ep


def chronological_split(df, ts_col="timestamp", fracs=(0.6, 0.2, 0.2), user_col=None,
                        label_col="is_fraud", purge_episodes=True, gap_hours=EPISODE_GAP_HOURS):
    """Train / validation / test by TIME (earliest -> latest).

    Returns (train_idx, val_idx, test_idx, info). When `purge_episodes` and a
    user column are available, any training/validation row that belongs to a
    fraud episode which continues past that split's end is dropped, so no
    incident is straddled across a boundary.
    """
    assert abs(sum(fracs) - 1) < 1e-9
    ts = pd.to_datetime(df[ts_col], format="ISO8601")
    order = ts.sort_values(kind="stable").index.to_numpy()
    n = len(order)
    c1, c2 = int(n * fracs[0]), int(n * (fracs[0] + fracs[1]))
    train, val, test = order[:c1], order[c1:c2], order[c2:]
    cut1, cut2 = ts.loc[order[c1]], ts.loc[order[c2]]

    purged = {"train": 0, "validation": 0}
    if purge_episodes and user_col is not None and user_col in df.columns:
        ep = assign_episodes(df, user_col, ts_col, label_col, gap_hours)
        ep_end = ts.groupby(ep).max()
        ep_end = ep_end[ep_end.index >= 0]

        def keep(idx, cutoff, name):
            e = ep.loc[idx]
            crosses = (e >= 0) & (e.map(ep_end) >= cutoff)
            purged[name] = int(crosses.sum())
            return idx[~crosses.to_numpy()]

        train = keep(train, cut1, "train")
        val = keep(val, cut2, "validation")

    info = {
        "split": "chronological",
        "train_until": str(cut1), "validation_until": str(cut2),
        "rows": {"train": len(train), "validation": len(val), "test": len(test)},
        "fraud": {k: int(df.loc[v, label_col].sum()) for k, v in
                  (("train", train), ("validation", val), ("test", test))},
        "purged_rows_for_straddling_fraud_episodes": purged,
    }
    return train, val, test, info


def random_split(df, fracs=(0.6, 0.2, 0.2), label_col="is_fraud", seed=42):
    """The naive baseline, kept ONLY to quantify how much it inflates scores."""
    rng = np.random.default_rng(seed)
    idx = rng.permutation(df.index.to_numpy())
    n = len(idx)
    c1, c2 = int(n * fracs[0]), int(n * (fracs[0] + fracs[1]))
    train, val, test = idx[:c1], idx[c1:c2], idx[c2:]
    info = {
        "split": "random (naive baseline)",
        "rows": {"train": len(train), "validation": len(val), "test": len(test)},
        "fraud": {k: int(df.loc[v, label_col].sum()) for k, v in
                  (("train", train), ("validation", val), ("test", test))},
    }
    return train, val, test, info


def user_holdout(df, user_col="user_synthetic_id", frac=0.2, seed=42):
    """Randomly reserves `frac` of USERS; none of their transactions may be
    used for training or calibration. Returns the held-out user ids."""
    users = df[user_col].unique()
    rng = np.random.default_rng(seed)
    held = rng.choice(users, size=int(len(users) * frac), replace=False)
    return set(held.tolist())
