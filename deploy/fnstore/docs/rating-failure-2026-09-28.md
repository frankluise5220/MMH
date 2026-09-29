# 2026-09-28 FN App Store MMH rating submission failure

- Symptom: Rating MMH in FN App Store failed with Unexpected token '<' because the client expected JSON but received an HTML error page. Ratings for official-source apps worked.
- Root cause: The VPS container was still running fn-appstores-server image 2.2.0 and mounted the legacy app.py over /app/app.py. That legacy app had no rating API route, so rating requests returned 404 HTML.
- Fix: On fnvps, switched to ccr.ccs.tencentyun.com/hhxs2025/fn-appstores-server:2.8.4, removed the legacy app.py override, kept the data directory mounted to /app/data, and set BASE_URL to http://fnapp.floatingice.win.
- Verification: The health endpoint returned status=ok. The public and direct-port rating endpoints returned HTTP 200 JSON for /api/rating/mmh with success=true, app_id=mmh, rating_avg=0, and rating_count=0.
- Deployment note: Do not restore image 2.2.0 or mount the legacy app.py over /app/app.py. The host path on the left side of the -v mapping must be adjusted to the actual data directory.
