"""1D-TCN 打鍵判定モデル学習 & ONNX エクスポート スクリプト

ml/dataset/*.csv (通常打鍵および各種負例CSV) を読み込み、
1. 全データから6次元特徴量 (rx, ry, rz, vx, vy, vz) の Z-score 正規化パラメータを算出し、public/model_index_scaler.json に保存
2. ファイルごとの時系列スライディングウィンドウ (過去6フレーム, [1, 6, 6]) を生成
3. クラス不均衡を補正する pos_weight を適用した BCEWithLogitsLoss で 1D-TCN (Flatten型) を学習
4. 各データセット（打鍵および負例）での Precision, Recall, F1 スコアを評価
5. Web 推論用 ONNX (public/model_index.onnx) へのエクスポート
を実行します。
"""

import os
import glob
import csv
import json
import numpy as np
import onnx
from onnx import helper, TensorProto
import onnxruntime as ort


# ==========================================
# 1. データセット読み込み & 前処理
# ==========================================
def load_csv_dataset(file_path):
    """単一CSVファイルから特徴量 (6次元: rx~vz) と label (0 or 1) を取得"""
    features = []
    labels = []

    with open(file_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rx = float(row["rx"])
            ry = float(row["ry"])
            rz = float(row["rz"])
            vx = float(row["vx"])
            vy = float(row["vy"])
            vz = float(row["vz"])
            lbl = float(row.get("label", 0.0))

            features.append([rx, ry, rz, vx, vy, vz])
            labels.append(lbl)

    return np.array(features, dtype=np.float32), np.array(labels, dtype=np.float32)


def prepare_dataset(dataset_dir="ml/dataset", window_size=6, train_ratio=0.8):
    """ml/dataset/ 配下の全CSVを走査し、Z-score 正規化パラメータ算出およびウィンドウ分割を実施"""
    csv_files = sorted(glob.glob(os.path.join(dataset_dir, "*.csv")))
    if not csv_files:
        raise FileNotFoundError(f"CSVデータセットが見つかりません: {dataset_dir}")

    print("=== データセット走査開始 ===")
    all_features = []
    file_data_list = []

    total_pos_raw = 0
    total_neg_raw = 0

    for fp in csv_files:
        fname = os.path.basename(fp)
        feats, lbls = load_csv_dataset(fp)
        pos_cnt = int(np.sum(lbls == 1.0))
        neg_cnt = int(np.sum(lbls == 0.0))
        total_pos_raw += pos_cnt
        total_neg_raw += neg_cnt
        print(f"  読み込み: {fname:<25} (サンプル数: {len(feats):4d}, 正例HIT: {pos_cnt:2d}, 負例: {neg_cnt:4d})")

        all_features.append(feats)
        file_data_list.append((fp, feats, lbls))

    print(f"\n全データセット総計: {total_pos_raw + total_neg_raw} サンプル (正例HIT: {total_pos_raw}, 負例: {total_neg_raw})")

    # 1. 読み込んだ全データの特徴量（6次元）から平均値（mean）と標準偏差（std）を計算
    stacked_feats = np.vstack(all_features)
    scaler_mean = np.mean(stacked_feats, axis=0).astype(np.float32)
    scaler_std = (np.std(stacked_feats, axis=0) + 1e-6).astype(np.float32)

    # 2. スケーラーパラメータを public/model_index_scaler.json に保存
    scaler_info = {
        "feature_names": ["rx", "ry", "rz", "vx", "vy", "vz"],
        "mean": scaler_mean.tolist(),
        "std": scaler_std.tolist(),
        "window_size": window_size,
    }
    os.makedirs("public", exist_ok=True)
    with open("public/model_index_scaler.json", "w", encoding="utf-8") as f:
        json.dump(scaler_info, f, indent=2)

    print(f"\n[OK] Z-score スケーラーパラメータを更新保存しました: public/model_index_scaler.json")
    print(f"  Scaler Mean: {scaler_mean.tolist()}")
    print(f"  Scaler Std : {scaler_std.tolist()}")

    # 3. ファイル単位で時系列ウィンドウ生成 & Train / Val 分割
    X_train_list, y_train_list = [], []
    X_val_list, y_val_list = [], []

    for fp, feats, lbls in file_data_list:
        if len(feats) < window_size:
            continue

        # Z-score 正規化適用
        norm_feats = (feats - scaler_mean) / scaler_std

        # スライディングウィンドウ作成
        windows = []
        target_labels = []
        for i in range(len(feats) - window_size + 1):
            w = norm_feats[i : i + window_size]
            # Conv1d 用に (channel=6, time=6) に転置
            windows.append(w.T)
            target_labels.append(lbls[i + window_size - 1])

        windows = np.array(windows, dtype=np.float32)
        target_labels = np.array(target_labels, dtype=np.float32).reshape(-1, 1)

        # 各ファイル内で時系列順に Train (80%) / Val (20%) に分割（時系列リーク防止）
        n_windows = len(windows)
        split_idx = int(n_windows * train_ratio)

        X_train_list.append(windows[:split_idx])
        y_train_list.append(target_labels[:split_idx])

        X_val_list.append(windows[split_idx:])
        y_val_list.append(target_labels[split_idx:])

    X_train = np.vstack(X_train_list)
    y_train = np.vstack(y_train_list)
    X_val = np.vstack(X_val_list)
    y_val = np.vstack(y_val_list)

    train_pos = int(np.sum(y_train >= 0.5))
    train_neg = int(np.sum(y_train < 0.5))
    val_pos = int(np.sum(y_val >= 0.5))
    val_neg = int(np.sum(y_val < 0.5))

    # クラス不均衡補正用の pos_weight
    pos_weight = float(train_neg / max(train_pos, 1))

    print(f"\n=== ウィンドウデータセット準備完了 (window_size={window_size}) ===")
    print(f"訓練セット: {len(X_train)} 件 (HIT: {train_pos} 件, 通常: {train_neg} 件, pos_weight: {pos_weight:.2f})")
    print(f"検証セット: {len(X_val)} 件 (HIT: {val_pos} 件, 通常: {val_neg} 件)")

    return X_train, y_train, X_val, y_val, pos_weight, scaler_mean, scaler_std, file_data_list


# ==========================================
# 2. NumPy ベース 1D-TCN 学習エンジン (Flatten 版)
# ==========================================
class Numpy1DTCN:
    """
    アーキテクチャ:
      Conv1d(6 -> 16, k=3, pad=1) + ReLU
      Conv1d(16 -> 8, k=3, pad=1) + ReLU
      Flatten(8 * 6 = 48)  # 時間順序を完全保持
      Linear(48 -> 1)
    """
    def __init__(self, seed=42):
        np.random.seed(seed)
        # He 初期化
        self.w1 = np.random.randn(16, 6, 3).astype(np.float32) * np.sqrt(2.0 / (6 * 3))
        self.b1 = np.zeros(16, dtype=np.float32)

        self.w2 = np.random.randn(8, 16, 3).astype(np.float32) * np.sqrt(2.0 / (16 * 3))
        self.b2 = np.zeros(8, dtype=np.float32)

        self.w3 = np.random.randn(48, 1).astype(np.float32) * np.sqrt(2.0 / 48)
        self.b3 = np.zeros(1, dtype=np.float32)

        # Adam 状態
        self.m = [np.zeros_like(p) for p in [self.w1, self.b1, self.w2, self.b2, self.w3, self.b3]]
        self.v = [np.zeros_like(p) for p in [self.w1, self.b1, self.w2, self.b2, self.w3, self.b3]]
        self.t = 0

    def forward(self, x):
        # x: [N, 6, 6] (N, channel, time)
        N, _, L = x.shape  # L = 6

        # Conv1 (pad=1)
        x_pad1 = np.pad(x, ((0, 0), (0, 0), (1, 1)), mode='constant')
        c1 = np.zeros((N, 16, L), dtype=np.float32)
        for i in range(L):
            patch = x_pad1[:, :, i : i + 3]  # [N, 6, 3]
            c1[:, :, i] = np.tensordot(patch, self.w1, axes=([1, 2], [1, 2])) + self.b1

        r1 = np.maximum(0, c1)

        # Conv2 (pad=1)
        r1_pad = np.pad(r1, ((0, 0), (0, 0), (1, 1)), mode='constant')
        c2 = np.zeros((N, 8, L), dtype=np.float32)
        for i in range(L):
            patch = r1_pad[:, :, i : i + 3]  # [N, 16, 3]
            c2[:, :, i] = np.tensordot(patch, self.w2, axes=([1, 2], [1, 2])) + self.b2

        r2 = np.maximum(0, c2)  # [N, 8, 6]

        # Flatten -> [N, 48]
        flat = r2.reshape(N, 48)

        # Linear -> [N, 1] (Logit 出力)
        out = np.dot(flat, self.w3) + self.b3

        cache = (x, x_pad1, c1, r1, r1_pad, c2, r2, flat)
        return out, cache

    def backward(self, d_out, cache):
        x, x_pad1, c1, r1, r1_pad, c2, r2, flat = cache
        N, _, L = x.shape

        # Linear grad
        dw3 = np.dot(flat.T, d_out) / N  # [48, 1]
        db3 = np.sum(d_out, axis=0) / N  # [1]
        d_flat = np.dot(d_out, self.w3.T)  # [N, 48]

        # Flatten grad -> [N, 8, 6]
        d_r2 = d_flat.reshape(N, 8, L)
        d_c2 = d_r2 * (c2 > 0)

        # Conv2 grad
        dw2 = np.zeros_like(self.w2)
        db2 = np.sum(d_c2, axis=(0, 2)) / N
        d_r1_pad = np.zeros_like(r1_pad)
        for i in range(L):
            patch = r1_pad[:, :, i : i + 3]  # [N, 16, 3]
            for o in range(8):
                dw2[o] += np.tensordot(d_c2[:, o, i], patch, axes=(0, 0)) / N
            d_r1_pad[:, :, i : i + 3] += np.tensordot(d_c2[:, :, i], self.w2, axes=(1, 0))
        d_r1 = d_r1_pad[:, :, 1:-1]
        d_c1 = d_r1 * (c1 > 0)

        # Conv1 grad
        dw1 = np.zeros_like(self.w1)
        db1 = np.sum(d_c1, axis=(0, 2)) / N
        for i in range(L):
            patch = x_pad1[:, :, i : i + 3]
            for o in range(16):
                dw1[o] += np.tensordot(d_c1[:, o, i], patch, axes=(0, 0)) / N

        return [dw1, db1, dw2, db2, dw3, db3]

    def step(self, grads, lr=0.003, beta1=0.9, beta2=0.999, eps=1e-8):
        self.t += 1
        params = [self.w1, self.b1, self.w2, self.b2, self.w3, self.b3]
        for idx in range(len(params)):
            g = grads[idx]
            self.m[idx] = beta1 * self.m[idx] + (1 - beta1) * g
            self.v[idx] = beta2 * self.v[idx] + (1 - beta2) * (g ** 2)
            m_hat = self.m[idx] / (1 - beta1 ** self.t)
            v_hat = self.v[idx] / (1 - beta2 ** self.t)
            params[idx] -= lr * m_hat / (np.sqrt(v_hat) + eps)


# ==========================================
# 3. 学習ループと検証
# ==========================================
def train_model(X_train, y_train, X_val, y_val, pos_weight, epochs=50, batch_size=32, lr=0.003):
    model = Numpy1DTCN(seed=42)
    best_f1 = -1.0
    best_weights = None
    final_metrics = {}

    print(f"\n=== 1D-TCN 学習開始 (エポック数: {epochs}, 学習率: {lr}, pos_weight: {pos_weight:.2f}) ===")

    for epoch in range(1, epochs + 1):
        perm = np.random.permutation(len(X_train))
        epoch_loss = 0.0
        batches = 0

        for b_start in range(0, len(X_train), batch_size):
            b_idx = perm[b_start : b_start + batch_size]
            xb, yb = X_train[b_idx], y_train[b_idx]

            logits, cache = model.forward(xb)

            # BCEWithLogitsLoss (pos_weight 適用)
            sig = 1.0 / (1.0 + np.exp(-np.clip(logits, -20, 20)))
            loss = -(pos_weight * yb * np.log(sig + 1e-7) + (1.0 - yb) * np.log(1.0 - sig + 1e-7))
            epoch_loss += np.mean(loss)
            batches += 1

            d_logits = sig * (pos_weight * yb + (1.0 - yb)) - pos_weight * yb
            grads = model.backward(d_logits, cache)
            model.step(grads, lr=lr)

        # Validation 評価 (打鍵判定閾値 prob >= 0.5)
        val_logits, _ = model.forward(X_val)
        val_sig = 1.0 / (1.0 + np.exp(-np.clip(val_logits, -20, 20)))
        val_loss = np.mean(-(pos_weight * y_val * np.log(val_sig + 1e-7) + (1.0 - y_val) * np.log(1.0 - val_sig + 1e-7)))
        val_preds = (val_sig >= 0.5).astype(np.float32)

        tp = np.sum((val_preds == 1) & (y_val >= 0.5))
        fp = np.sum((val_preds == 1) & (y_val < 0.5))
        fn = np.sum((val_preds == 0) & (y_val >= 0.5))
        tn = np.sum((val_preds == 0) & (y_val < 0.5))

        precision = tp / (tp + fp + 1e-7)
        recall = tp / (tp + fn + 1e-7)
        f1 = 2 * precision * recall / (precision + recall + 1e-7)

        final_metrics = {
            "epoch": epoch,
            "train_loss": epoch_loss / max(batches, 1),
            "val_loss": float(val_loss),
            "precision": float(precision),
            "recall": float(recall),
            "f1": float(f1),
            "tp": int(tp), "fp": int(fp), "fn": int(fn), "tn": int(tn),
        }

        if epoch % 5 == 0 or epoch == epochs:
            print(f"Epoch [{epoch:02d}/{epochs:02d}] "
                  f"Train Loss: {final_metrics['train_loss']:.4f} | "
                  f"Val Loss: {final_metrics['val_loss']:.4f} | "
                  f"Val Prec: {precision:.4f}, Rec: {recall:.4f}, F1: {f1:.4f} "
                  f"(TP={tp}, FP={fp}, FN={fn}, TN={tn})")

        # F1最良、または同値でRecallが高い重みを優先保存
        if f1 > best_f1 or (f1 == best_f1 and recall > 0):
            best_f1 = f1
            best_weights = [p.copy() for p in [model.w1, model.b1, model.w2, model.b2, model.w3, model.b3]]

    print(f"\n[Best Validation F1: {best_f1:.4f}] の重みを採用します。")
    if best_weights is not None:
        model.w1, model.b1, model.w2, model.b2, model.w3, model.b3 = best_weights

    return model, final_metrics


# ==========================================
# 4. 個別データセットでの検証
# ==========================================
def evaluate_all_individual_files(model, scaler_mean, scaler_std, dataset_dir="ml/dataset", window_size=6):
    csv_files = sorted(glob.glob(os.path.join(dataset_dir, "*.csv")))
    print(f"\n=== 全データセット個別検証 (打鍵判定閾値 prob >= 0.5) ===")

    results = []
    total_tp = 0
    total_fp = 0
    total_fn = 0
    total_tn = 0

    for fp in csv_files:
        fname = os.path.basename(fp)
        feats, lbls = load_csv_dataset(fp)
        if len(feats) < window_size:
            continue

        norm_feats = (feats - scaler_mean) / scaler_std
        windows = []
        target_labels = []
        for i in range(len(feats) - window_size + 1):
            w = norm_feats[i : i + window_size]
            windows.append(w.T)
            target_labels.append(lbls[i + window_size - 1])

        X = np.array(windows, dtype=np.float32)
        y = np.array(target_labels, dtype=np.float32).reshape(-1, 1)

        logits, _ = model.forward(X)
        sig = 1.0 / (1.0 + np.exp(-np.clip(logits, -20, 20)))
        preds = (sig >= 0.5).astype(np.float32)

        tp = int(np.sum((preds == 1) & (y >= 0.5)))
        fp = int(np.sum((preds == 1) & (y < 0.5)))
        fn = int(np.sum((preds == 0) & (y >= 0.5)))
        tn = int(np.sum((preds == 0) & (y < 0.5)))
        prec = tp / (tp + fp + 1e-7)
        rec = tp / (tp + fn + 1e-7)
        f1 = 2 * prec * rec / (prec + rec + 1e-7)

        total_tp += tp
        total_fp += fp
        total_fn += fn
        total_tn += tn

        status = ""
        if "neg" in fname:
            status = " [負例: 誤検知ゼロ達成!]" if fp == 0 else f" [警告: FP={fp}件検出]"
        elif "tap" in fname:
            status = f" [打鍵検出率: {rec*100:.1f}%]"

        print(f"  {fname:<25} -> TP: {tp:2d}, FP: {fp:2d}, FN: {fn:2d}, TN: {tn:4d} | Prec: {prec:.3f}, Rec: {rec:.3f}, F1: {f1:.3f}{status}")
        results.append({
            "file": fname,
            "tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "prec": prec, "rec": rec, "f1": f1
        })

    overall_prec = total_tp / (total_tp + total_fp + 1e-7)
    overall_rec = total_tp / (total_tp + total_fn + 1e-7)
    overall_f1 = 2 * overall_prec * overall_rec / (overall_prec + overall_rec + 1e-7)
    print(f"\n--- 全体集計結果 ---")
    print(f"  総計: TP={total_tp}, FP={total_fp}, FN={total_fn}, TN={total_tn}")
    print(f"  全体 Precision: {overall_prec:.4f}, Recall: {overall_rec:.4f}, F1: {overall_f1:.4f}")

    return results, (overall_prec, overall_rec, overall_f1)


# ==========================================
# 5. ONNX モデル生成とエクスポート
# ==========================================
def export_to_onnx(model, output_path="public/model_index.onnx"):
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    # 入出力テンソル定義 (動的バッチ軸)
    input_tensor = helper.make_tensor_value_info('input', TensorProto.FLOAT, ['batch_size', 6, 6])
    output_tensor = helper.make_tensor_value_info('output', TensorProto.FLOAT, ['batch_size', 1])

    # Initializers (重みテンソル)
    conv1_w = helper.make_tensor('conv1_w', TensorProto.FLOAT, [16, 6, 3], model.w1.flatten().tolist())
    conv1_b = helper.make_tensor('conv1_b', TensorProto.FLOAT, [16], model.b1.flatten().tolist())

    conv2_w = helper.make_tensor('conv2_w', TensorProto.FLOAT, [8, 16, 3], model.w2.flatten().tolist())
    conv2_b = helper.make_tensor('conv2_b', TensorProto.FLOAT, [8], model.b2.flatten().tolist())

    fc_w = helper.make_tensor('fc_w', TensorProto.FLOAT, [48, 1], model.w3.flatten().tolist())
    fc_b = helper.make_tensor('fc_b', TensorProto.FLOAT, [1], model.b3.flatten().tolist())

    # ノード定義 (Conv1d -> ReLU -> Conv1d -> ReLU -> Flatten -> Gemm)
    node_conv1 = helper.make_node('Conv', ['input', 'conv1_w', 'conv1_b'], ['c1'],
                                  kernel_shape=[3], pads=[1, 1])
    node_relu1 = helper.make_node('Relu', ['c1'], ['r1'])

    node_conv2 = helper.make_node('Conv', ['r1', 'conv2_w', 'conv2_b'], ['c2'],
                                  kernel_shape=[3], pads=[1, 1])
    node_relu2 = helper.make_node('Relu', ['c2'], ['r2'])

    node_flat = helper.make_node('Flatten', ['r2'], ['flat'], axis=1)
    node_gemm = helper.make_node('Gemm', ['flat', 'fc_w', 'fc_b'], ['output'],
                                 alpha=1.0, beta=1.0, transB=0)

    # グラフ構築
    graph = helper.make_graph(
        [node_conv1, node_relu1, node_conv2, node_relu2, node_flat, node_gemm],
        'Tiny1DTCN_Flatten_Index',
        [input_tensor],
        [output_tensor],
        initializer=[conv1_w, conv1_b, conv2_w, conv2_b, fc_w, fc_b]
    )

    onnx_model = helper.make_model(graph, opset_imports=[helper.make_operatorsetid('', 17)])
    onnx_model.ir_version = 8

    # ONNX 構造チェック & 保存
    onnx.checker.check_model(onnx_model)
    onnx.save(onnx_model, output_path)
    print(f"\n[OK] 1D-TCN ONNX モデルを出力・上書き更新しました: {output_path}")

    # ONNX Runtime で推論テスト
    session = ort.InferenceSession(output_path)
    dummy_input = np.random.randn(1, 6, 6).astype(np.float32)
    res = session.run(['output'], {'input': dummy_input})
    print(f"[OK] ONNX Runtime 推論テスト成功! 入力シェイプ: [1, 6, 6], 出力シェイプ: {res[0].shape}, 出力logit: {res[0][0][0]:.4f}")


def main():
    X_train, y_train, X_val, y_val, pos_weight, scaler_mean, scaler_std, file_data_list = prepare_dataset()
    trained_model, final_metrics = train_model(X_train, y_train, X_val, y_val, pos_weight, epochs=50, batch_size=32, lr=0.003)
    indiv_results, overall_metrics = evaluate_all_individual_files(trained_model, scaler_mean, scaler_std)
    export_to_onnx(trained_model, "public/model_index.onnx")


if __name__ == '__main__':
    main()
