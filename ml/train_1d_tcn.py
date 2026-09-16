"""1D-TCN 打鍵判定モデル学習 & ONNX エクスポート スクリプト

人差し指運動特徴量 (ml/dataset/*.json) を読み込み、
1. 連続 HIT 区間から急減速ピークを抽出する自動リラベリング
2. ファイル単位の厳密な Train / Val 分割（時系列リーク防止）
3. 6次元特徴量の Z-score 正規化 (public/model_index_scaler.json に書き出し)
4. 時間順序を保持する Flatten 型 1D-TCN (AdaptiveAvgPool1d 撤廃) の学習
5. Web 推論用 ONNX (public/model_index.onnx) へのエクスポート
を実行します。
"""

import os
import glob
import json
import numpy as np
import onnx
from onnx import helper, TensorProto
import onnxruntime as ort

# ==========================================
# 1. 自動リラベリング & データセット読み込み
# ==========================================
def load_and_relabel(file_path):
    """連続した label=1 区間から、下向き速度 vy の急減ピーク（机衝突インパクト）を特定し、
    その前後1フレーム（計3フレーム: t-1, t, t+1）に時間的許容幅を持たせた打鍵正例ラベル（1.0）を付与"""
    with open(file_path, "r", encoding="utf-8") as f:
        frames = json.load(f)

    n = len(frames)
    new_labels = [0.0] * n
    i = 0

    while i < n:
        if frames[i]["label"] == 1:
            start = i
            while i < n and frames[i]["label"] == 1:
                i += 1
            end = i  # [start, end) が HIT 区間

            # 区間内で直前フレームからの下向き速度の急減量 (prev_vy - curr_vy) が最大のフレームを特定
            best_idx = start
            best_decel = -float("inf")
            for k in range(start, end):
                prev_vy = frames[k - 1]["features"][4] if k > 0 else 0.0
                curr_vy = frames[k]["features"][4]
                decel = prev_vy - curr_vy
                if decel > best_decel:
                    best_decel = decel
                    best_idx = k

            # 衝突ピークを中心とする前後1フレーム（計3フレーム: 約75msの時間許容幅）を正例(1.0)として付与
            new_labels[best_idx] = 1.0
            if best_idx - 1 >= 0:
                new_labels[best_idx - 1] = 1.0
            if best_idx + 1 < n:
                new_labels[best_idx + 1] = 1.0
        else:
            i += 1

    return frames, new_labels


def prepare_dataset(dataset_dir="ml/dataset", window_size=6):
    """ファイル単位で Train / Val を厳密に分離し、Z-score 正規化を適用してウィンドウを生成"""
    # 訓練用: 打鍵セッション1 + 空中運動セッション（負例を豊富に学習）
    train_files = [
        os.path.join(dataset_dir, "dataset_index_20260915_175925.json"),
        os.path.join(dataset_dir, "dataset_index_20260915_180121.json"),
    ]
    # 検証用: 打鍵セッション2 + 静止セッション（未知セッションでの汎化性能評価）
    val_files = [
        os.path.join(dataset_dir, "dataset_index_20260915_180018.json"),
        os.path.join(dataset_dir, "dataset_index_20260915_180157.json"),
    ]

    for fp in train_files + val_files:
        if not os.path.exists(fp):
            raise FileNotFoundError(f"データセットが見つかりません: {fp}")

    # 1. 訓練データから Z-score 正規化パラメータ（mean, std）を算出
    all_train_feats = []
    for fp in train_files:
        frames, _ = load_and_relabel(fp)
        for fr in frames:
            all_train_feats.append(fr["features"])

    scaler_mean = np.mean(all_train_feats, axis=0).astype(np.float32)
    scaler_std = (np.std(all_train_feats, axis=0) + 1e-6).astype(np.float32)

    # 2. スケーラーパラメータを JSON 保存
    scaler_info = {
        "feature_names": ["rx", "ry", "rz", "vx", "vy", "vz"],
        "mean": scaler_mean.tolist(),
        "std": scaler_std.tolist(),
        "window_size": window_size,
    }
    os.makedirs("public", exist_ok=True)
    with open("public/model_index_scaler.json", "w", encoding="utf-8") as f:
        json.dump(scaler_info, f, indent=2)
    print(f"[OK] スケーラーパラメータを保存しました: public/model_index_scaler.json")
    print(f"  Scaler Mean: {scaler_mean}")
    print(f"  Scaler Std : {scaler_std}")

    # 3. ウィンドウ生成ヘルパー
    def build_windows(files):
        X, y = [], []
        for fp in files:
            frames, labels = load_and_relabel(fp)
            norm_feats = [
                (np.array(fr["features"], dtype=np.float32) - scaler_mean) / scaler_std
                for fr in frames
            ]
            for i in range(len(frames) - window_size + 1):
                window = norm_feats[i : i + window_size]
                # (time=6, channel=6) -> Conv1d 用に転置して (channel=6, time=6)
                X.append(np.array(window, dtype=np.float32).T)
                y.append(labels[i + window_size - 1])
        return np.array(X, dtype=np.float32), np.array(y, dtype=np.float32).reshape(-1, 1)

    X_train, y_train = build_windows(train_files)
    X_val, y_val = build_windows(val_files)

    num_pos = int(np.sum(y_train >= 0.5))
    num_neg = int(np.sum(y_train < 0.5))
    pos_weight = float(num_neg / max(num_pos, 1))

    print(f"\n=== データセット準備完了 ===")
    print(f"訓練セット: {len(X_train)} 件 (HIT: {num_pos} 件, 通常: {num_neg} 件, pos_weight: {pos_weight:.2f})")
    print(f"検証セット: {len(X_val)} 件 (HIT: {int(np.sum(y_val >= 0.5))} 件, 通常: {int(np.sum(y_val < 0.5))} 件)")

    return X_train, y_train, X_val, y_val, pos_weight, scaler_mean, scaler_std


# ==========================================
# 2. NumPy ベース 1D-TCN 学習エンジン (Flatten 版)
#    AdaptiveAvgPool1d を撤廃し、時間軸順序を保持
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
        # x: [N, 6, 6]
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

        # Flatten -> [N, 48] (時間軸全体の時系列パターンを維持)
        flat = r2.reshape(N, 48)

        # Linear -> [N, 1]
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
def train_model(X_train, y_train, X_val, y_val, pos_weight, epochs=45, batch_size=32, lr=0.003):
    model = Numpy1DTCN(seed=42)
    best_f1 = -1.0
    best_weights = None

    print(f"\n=== 学習開始 (エポック数: {epochs}, 学習率: {lr}) ===")

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
        val_preds = (val_sig >= 0.5).astype(np.float32)

        tp = np.sum((val_preds == 1) & (y_val >= 0.5))
        fp = np.sum((val_preds == 1) & (y_val < 0.5))
        fn = np.sum((val_preds == 0) & (y_val >= 0.5))
        tn = np.sum((val_preds == 0) & (y_val < 0.5))

        precision = tp / (tp + fp + 1e-7)
        recall = tp / (tp + fn + 1e-7)
        f1 = 2 * precision * recall / (precision + recall + 1e-7)

        if epoch % 5 == 0 or epoch == epochs:
            print(f"Epoch [{epoch:02d}/{epochs:02d}] "
                  f"Train Loss: {epoch_loss / max(batches, 1):.4f} | "
                  f"Val Prec: {precision:.4f}, Rec: {recall:.4f}, F1: {f1:.4f} "
                  f"(TP={tp}, FP={fp}, FN={fn}, TN={tn})")

        if f1 > best_f1:
            best_f1 = f1
            best_weights = [p.copy() for p in [model.w1, model.b1, model.w2, model.b2, model.w3, model.b3]]

    print(f"\n[Best Validation F1: {best_f1:.4f}] の重みを採用します。")
    if best_weights is not None:
        model.w1, model.b1, model.w2, model.b2, model.w3, model.b3 = best_weights

    return model


# ==========================================
# 4. 個別データセットでの検証 (空中運動FP確認)
# ==========================================
def evaluate_individual_files(model, scaler_mean, scaler_std, dataset_dir="ml/dataset", window_size=6):
    files = sorted(glob.glob(os.path.join(dataset_dir, "*.json")))
    print(f"\n=== 全データセット個別検証 (prob >= 0.5) ===")

    for fp in files:
        fname = os.path.basename(fp)
        frames, labels = load_and_relabel(fp)
        if len(frames) < window_size:
            continue

        norm_feats = [
            (np.array(fr["features"], dtype=np.float32) - scaler_mean) / scaler_std
            for fr in frames
        ]
        windows = []
        target_labels = []
        for i in range(len(frames) - window_size + 1):
            w = norm_feats[i : i + window_size]
            windows.append(np.array(w, dtype=np.float32).T)
            target_labels.append(labels[i + window_size - 1])

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

        status_msg = " [空中運動: 誤検知ゼロ達成!]" if ("180121" in fname and fp == 0) else ""
        print(f"  {fname:<36} -> TP: {tp:2d}, FP: {fp:2d}, FN: {fn:2d}, TN: {tn:4d} | Prec: {prec:.3f}, Rec: {rec:.3f}, F1: {f1:.3f}{status_msg}")


# ==========================================
# 5. ONNX モデル生成とエクスポート
# ==========================================
def export_to_onnx(model, output_path="public/model_index.onnx"):
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    # 入出力テンソル定義 (動的バッチ軸)
    input_tensor = helper.make_tensor_value_info('input', TensorProto.FLOAT, ['batch_size', 6, 6])
    output_tensor = helper.make_tensor_value_info('output', TensorProto.FLOAT, ['batch_size', 1])

    # Initializers (重み)
    conv1_w = helper.make_tensor('conv1_w', TensorProto.FLOAT, [16, 6, 3], model.w1.flatten().tolist())
    conv1_b = helper.make_tensor('conv1_b', TensorProto.FLOAT, [16], model.b1.flatten().tolist())

    conv2_w = helper.make_tensor('conv2_w', TensorProto.FLOAT, [8, 16, 3], model.w2.flatten().tolist())
    conv2_b = helper.make_tensor('conv2_b', TensorProto.FLOAT, [8], model.b2.flatten().tolist())

    fc_w = helper.make_tensor('fc_w', TensorProto.FLOAT, [48, 1], model.w3.flatten().tolist())
    fc_b = helper.make_tensor('fc_b', TensorProto.FLOAT, [1], model.b3.flatten().tolist())

    # ノード定義 (Conv1d -> ReLU -> Conv1d -> ReLU -> Flatten -> Gemm)
    # ※ AdaptiveAvgPool1d を撤廃し、時間軸6×チャネル8=48次元を完全に保持
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
    print(f"\n[OK] 新型 1D-TCN ONNX モデルを出力しました: {output_path}")

    # ONNX Runtime で推論検証
    session = ort.InferenceSession(output_path)
    dummy_input = np.random.randn(1, 6, 6).astype(np.float32)
    res = session.run(['output'], {'input': dummy_input})
    print(f"[OK] ONNX Runtime 推論テスト成功! 出力形状: {res[0].shape}, 出力値: {res[0][0][0]:.4f}")


def main():
    X_train, y_train, X_val, y_val, pos_weight, scaler_mean, scaler_std = prepare_dataset()
    trained_model = train_model(X_train, y_train, X_val, y_val, pos_weight, epochs=45, batch_size=32, lr=0.003)
    evaluate_individual_files(trained_model, scaler_mean, scaler_std)
    export_to_onnx(trained_model, "public/model_index.onnx")


if __name__ == '__main__':
    main()
