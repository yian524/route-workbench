# 自行架站說明

本機使用只要執行 `python serve_product_v25.py`。以下是要讓其他人透過網路使用時，必須先處理的事項。

## 公開架站前必須處理

| 項目 | 現況 | 要做什麼 |
|---|---|---|
| Google 街景 | 使用 Google 舊式嵌入網址（`output=svembed`），不是 Google Maps Platform 正式的 Embed API，可能隨時失效 | 改用官方 Maps JavaScript API 或 Embed API（需要計費帳戶與金鑰），或拿掉街景 |
| 免費公用服務 | OSM 圖磚、Photon 示範伺服器、Valhalla FOSSGIS 公用伺服器都只允許低流量、公平使用 | 依流量改為自架，或改用付費供應商 |
| 同時使用人數 | 路線計算同一時間只處理一位使用者，其他人會收到 429（請稍後再試） | 自架 Valhalla，或改成佇列／多工作者架構 |
| 隱私說明 | 分享的導航連結與備份檔都包含位置 | 在網站上提供清楚的隱私說明 |

## 部署步驟

1. 用受維護的反向代理（reverse proxy，例如 Nginx）提供 HTTPS，把流量轉到 `127.0.0.1`。Python 內建伺服器只作為本機應用伺服器，不要直接對外開放。
2. 啟動時加上 `--origin https://你的網域`，這個值決定允許的 Host 與 Origin，不要改成接受任意來源。
3. 若反向代理也在本機，再加 `--trusted-proxy 127.0.0.1`，並讓代理**覆寫** `X-Real-IP` 為使用者的實際 IP（Nginx：`proxy_set_header X-Real-IP $remote_addr;`）。只信任明確指定的直接代理，不採用任意的 `X-Forwarded-For`。
4. 設定環境變數 `PLANNER_CLIENT_ID`，讓 Valhalla 識別你的部署；Valhalla 要求公開給終端使用者前先告知專案。
5. 若要更換地圖底圖：在啟動前設定 `PLANNER_TILE_URL`、`PLANNER_TILE_ATTRIBUTION`、`PLANNER_TILE_ATTRIBUTION_URL`。必須是 HTTPS、256 px 的 XYZ 圖磚，網址含 `{z}`、`{x}`、`{y}`，並同時提供來源文字與 HTTPS 來源連結；不要把私人憑證放進網址。
6. 用 `MANIFEST.json` 核對部署的檔案：`python tools/release_manifest.py --check`。

## 已採用的限制與保護

- 公開模式（資料夾內有 `PUBLIC_ONLY`）沒有伺服器端路線庫，只提供搜尋、路線計算、工作階段權杖與健康檢查。
- 每個使用者 IP 每分鐘最多 30 次位置服務請求；多人共用同一個網路出口時會共用這個額度。
- 伺服器不記錄搜尋文字或路線座標，上游連線只暫存在記憶體。
- `/health` 回報版本與保存模式，可用於監控。

## 回復

以上一版完整套件替換即可回退；使用者的路線存在各自的瀏覽器，不受伺服器回退影響。

## 第三方服務規範

- OpenStreetMap 圖磚使用政策：https://operations.osmfoundation.org/policies/tiles/
- Photon 示範伺服器：https://github.com/komoot/photon#demo-server
- Valhalla：https://valhalla.github.io/valhalla/
- Google Maps Platform 條款：https://cloud.google.com/maps-platform/terms
