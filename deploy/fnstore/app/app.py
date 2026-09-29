# ====================加载 vendor 依赖==============================
import sys
import os

# 判断运行环境
if getattr(sys, 'frozen', False):
    base_dir = os.path.dirname(os.path.abspath(sys.argv[0]))
else:
    base_dir = os.path.dirname(os.path.abspath(__file__))

# 加载 vendor
vendor_path = os.path.join(base_dir, 'vendor')
if os.path.exists(vendor_path):
    sys.path.insert(0, vendor_path)
else:
    print(f"⚠️ vendor 目录不存在: {vendor_path}")

# ======================第三方库导入=============================
import json
import hashlib
import threading
import requests
import time
import re
from datetime import datetime, timezone, timedelta

# 北京时区 UTC+8
CST = timezone(timedelta(hours=8))

def _now_cst():
    """返回北京时间（UTC+8）的 datetime，用于统计记录"""
    return datetime.now(CST)

def _cst_now_str():
    """返回北京时间字符串，如 '2026-09-24'（日期）或 '2026-09-24 09:12:34'（日期时间）"""
    now = _now_cst()
    return now.strftime('%Y-%m-%d'), now.strftime('%Y-%m-%d %H:%M:%S')
from flask import Flask, jsonify, request, Response, redirect, send_from_directory
from flask_cors import CORS
from werkzeug.middleware.proxy_fix import ProxyFix

flask_app = Flask(__name__)
CORS(flask_app)
# 经 nginx 反代（docker network → host），Flask 默认拿到 127.0.0.1，
# ProxyFix 让 Werkzeug 从 X-Forwarded-For / X-Real-IP 取真实客户端 IP
flask_app.wsgi_app = ProxyFix(flask_app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# ========== 配置 ==========
PORT = 5660

# ========== 数据目录（容器内路径） ==========
DATA_DIR = '/app/data'

# ========== 缓存配置 ==========
CACHE_TTL = 86400  # 24小时

# ========== 下载分发与统计配置 ==========
# GitHub 仓库（用于 /apps/*.fpk 的 302 跳转与统计页展示）
GITHUB_REPO = 'frankluise5220/MMH'
# 本源只分发 x86_64 包；arm64 用户走 GitHub 官方 raw 源
FPK_ARCH = 'x86_64'
# ========== 下载分发与统计配置 ==========
# True: 直接由 VPS 发送本地 FPK 文件（消耗 VPS 流量，统计更准确）
# False: /apps/*.fpk 计数后 302 跳转 GitHub Release（不占 VPS 带宽，但 FnDepot 轮询会重复计数）
SERVE_LOCAL_DOWNLOADS = True
# 下载统计文件（落在挂载的 data 卷，容器重启不丢；删除该文件即清零）
DOWNLOADS_PATH = os.path.join(DATA_DIR, 'download-stats.json')
# 软仓源管理页（4001 nginx 反代 /fnstore/ 或直接访问 5660/fnstore/）
ADMIN_HTML_PATH = os.path.join(DATA_DIR, 'admin', 'index.html')
# 本地直发目录：把文件按 GitHub 资产名放进 data/downloads/ 即可不经 GitHub 分发
# （优先级高于 GitHub 302；适合"直接发 VPS、不发 GitHub"的场景）
LOCAL_DOWNLOADS_DIR = os.path.join(DATA_DIR, 'downloads')

# ================================================================
# ========== 获取公网地址 ==========
# ================================================================

def get_base_url():
    """优先使用 PUBLIC_BASE_URL 环境变量，其次从请求中获取当前访问地址"""
    import os as _os
    _pub = _os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")
    if _pub:
        return _pub
    try:
        if request.host:
            return f"http://{request.host}"
    except:
        pass
    return "http://app.hhxs2026.top:5660"

# ================================================================
# ========== 获取应用列表 ==========
# ================================================================

def fetch_apps_from_local():
    """从本地 data 目录读取应用列表"""
    json_path = os.path.join(DATA_DIR, 'fn-appstores.json')
    
    if not os.path.exists(json_path):
        print(f"⚠️ fn-appstores.json 不存在: {json_path}")
        return []
    
    try:
        with open(json_path, 'r', encoding='utf-8') as f:
            apps = json.load(f)
    except Exception as e:
        print(f"⚠️ 读取 fn-appstores.json 失败: {e}")
        return []
    
    if not isinstance(apps, list):
        print("⚠️ fn-appstores.json 格式错误，应为数组")
        return []
    
    base_url = get_base_url()
    print(f"🌐 当前基础 URL: {base_url}")
    
    for app in apps:
        app_id = app.get('id')
        if not app_id:
            continue
        
        version = app.get('version', '')
        
        # download_url
        if 'download_url' not in app or not app['download_url']:
            fpk_filename = f'{app_id}-{version}.fpk'
            fpk_path = os.path.join(DATA_DIR, 'apps', fpk_filename)
            if os.path.exists(fpk_path):
                app['download_url'] = f"{base_url}/apps/{fpk_filename}"
            else:
                # 降级兼容 {id}.fpk
                fallback_path = os.path.join(DATA_DIR, 'apps', f'{app_id}.fpk')
                if os.path.exists(fallback_path):
                    app['download_url'] = f"{base_url}/apps/{app_id}.fpk"
                else:
                    app['download_url'] = ''
        
        # icon
        if 'icon' not in app or not app['icon']:
            icon_path = os.path.join(DATA_DIR, 'icons', f'{app_id}.PNG')
            if os.path.exists(icon_path):
                app['icon'] = f"{base_url}/icons/{app_id}.PNG"
            else:
                # 尝试小写
                icon_path_lower = os.path.join(DATA_DIR, 'icons', f'{app_id}.png')
                if os.path.exists(icon_path_lower):
                    app['icon'] = f"{base_url}/icons/{app_id}.png"
                else:
                    app['icon'] = ''
        
        # screenshots
        if 'screenshots' not in app or not app['screenshots']:
            preview_dir = os.path.join(DATA_DIR, 'previews', app_id)
            screenshots = []
            if os.path.exists(preview_dir):
                for filename in sorted(os.listdir(preview_dir)):
                    if filename.upper().endswith(('.PNG', '.JPG', '.JPEG', '.GIF', '.WEBP')):
                        screenshots.append(f"{base_url}/previews/{app_id}/{filename}")
            app['screenshots'] = screenshots
    
    apps = [app for app in apps if app.get('download_url')]
    print(f"✅ 从本地加载 {len(apps)} 个应用")
    return apps

def get_all_apps(force_refresh=False):
    """获取应用列表，带缓存"""
    cache_key = 'all_apps_list'
    
    if not force_refresh:
        cached = getattr(flask_app, '_app_cache', None)
        if cached and cached.get('key') == cache_key:
            cache_time = cached.get('time', 0)
            if time.time() - cache_time < CACHE_TTL:
                print(f"✅ 使用缓存应用列表")
                return cached.get('value', [])
    
    apps = fetch_apps_from_local()
    
    flask_app._app_cache = {
        'key': cache_key,
        'value': apps,
        'time': time.time()
    }
    
    return apps

# ================================================================
# ========== 🆕 下载统计 ==========
# ================================================================

_stats_lock = threading.Lock()

def _load_download_stats():
    """读取下载统计（文件不存在或损坏时从零开始）"""
    try:
        with open(DOWNLOADS_PATH, 'r', encoding='utf-8') as f:
            stats = json.load(f)
        if not isinstance(stats, dict):
            raise ValueError('格式错误')
        return stats
    except Exception:
        return {'total': 0, 'by_file': {}, 'by_day': {}, 'by_source': {'fndepot': 0, 'fnstore': 0, 'vps': 0}, 'log': []}

def _save_download_stats(stats):
    """原子写盘，避免写一半留下损坏的 JSON"""
    tmp_path = DOWNLOADS_PATH + '.tmp'
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, DOWNLOADS_PATH)

# ========== 同 IP 同文件去重（10 秒内视为同一次下载，防止 FnDepot 轮询重复计数） ==========
_dedup_lock = threading.Lock()
_dedup_cache = {}  # {(ip, filename): last_recorded_timestamp}

def _detect_source():
    """按请求特征判断下载来源：
    - User-Agent 含 'FnDepot' → fndepot（FnDepot 浏览器插件，经 nginx:80，发 302 后自己从 GitHub 下载）
    - Host 含 ':4001'            → fnstore（FN 软仓客户端，经 nginx:4001）
    - Host 含 ':5660'            → vps（专属源直连 5660）
    - 其他（无 FnDepot UA，Host 无端口） → vps
    注：飞牛应用中心 / 软仓客户端从 GitHub 直接下载，VPS 无法统计。
    """
    try:
        ua = request.headers.get('User-Agent', '')
        host = (request.host or '').lower().split(':', 1)[0]
        forwarded_host = (request.headers.get('X-Forwarded-Host') or '').lower().split(',', 1)[0].strip()
        forwarded_host = forwarded_host.split(':', 1)[0]
        if 'FnDepot' in ua:
            return 'fndepot'
        if host == 'synology.floatingice.win':
            return 'synology'
        if host == 'fnapp.floatingice.win':
            return 'fndepot'
        if forwarded_host == 'synology.floatingice.win':
            return 'synology'
        if ':4001' in (request.host or ''):
            return 'fnstore'
        if host == 'fnapp.floatingice.win' and ':5660' in (request.host or ''):
            return 'fnstore'
        if ':5660' in (request.host or ''):
            return 'vps'
        return 'vps'
    except Exception:
        return 'vps'

def record_download(filename):
    """记录一次 FPK 下载：同 IP+文件 10 秒内去重，只记录一次"""
    try:
        today_str, now_str = _cst_now_str()
        source = _detect_source()
        ip = request.headers.get('X-Real-IP') or request.remote_addr or ''
        key = (str(ip), str(filename))
        now_ts = time.time()
        window = 10.0
        should_record = False
        with _dedup_lock:
            last = _dedup_cache.get(key, 0)
            if now_ts - last >= window:
                _dedup_cache[key] = now_ts
                should_record = True
                if len(_dedup_cache) > 1000:
                    expired = [k for k, t in _dedup_cache.items() if now_ts - t >= window]
                    for k in expired:
                        del _dedup_cache[k]
        if not should_record:
            return  # 10 秒内同 IP 同文件，跳过
        with _stats_lock:
            stats = _load_download_stats()
            stats['total'] = int(stats.get('total', 0)) + 1
            by_file = stats.setdefault('by_file', {})
            by_file[filename] = int(by_file.get(filename, 0)) + 1
            by_day = stats.setdefault('by_day', {})
            by_day[today_str] = int(by_day.get(today_str, 0)) + 1
            by_source = stats.setdefault('by_source', {})
            by_source[source] = int(by_source.get(source, 0)) + 1
            # 提取版本号（如 mmh-0.1.65.fpk → 0.1.65）
            ver = ''
            m = re.match(r'^mmh-(?P<version>\d+\.\d+\.\d+)\.fpk$', filename)
            if m:
                ver = m.group('version')
            log = stats.setdefault('log', [])
            log.append({'time': now_str, 'file': filename, 'source': source, 'ip': ip, 'version': ver})
            stats['log'] = log[-300:]
            _save_download_stats(stats)
        print(f"📥 下载统计: {filename} (source={source})")
    except Exception as e:
        print(f"⚠️ 记录下载统计失败: {e}")

def build_github_download_url(filename):
    """mmh-<version>.fpk -> 对应 GitHub Release 资产地址；无法识别时返回 None"""
    m = re.match(r'^[A-Za-z0-9_-]+-(?P<version>\d+\.\d+\.\d+)\.fpk$', filename)
    if not m:
        return None
    version = m.group('version')
    return f"https://github.com/{GITHUB_REPO}/releases/download/v{version}/mmh-fnos-v{version}-{FPK_ARCH}.fpk"

def _sum_github_downloads():
    """从缓存的 GitHub releases 数据中汇总 FPK 资产的 GitHub 官方下载量（不含 VPS 计数）"""
    cached = getattr(flask_app, '_gh_cache', None)
    if not cached or not cached.get('raw'):
        return {}
    local_versions = _get_local_fpk_versions()
    result = {'total': 0, 'by_arch': {}, 'by_version': {}}
    for rel in cached['raw']:
        tag = rel.get('tag_name', '')
        ver = tag.lstrip('v') if tag else ''
        if ver not in local_versions:
            continue
        for a in rel.get('assets', []):
            name = a.get('name', '')
            if not name.endswith('.fpk'):
                continue
            cnt = a.get('download_count', 0) or 0
            result['total'] += cnt
            if 'x86_64' in name:
                result['by_arch']['x86_64'] = result['by_arch'].get('x86_64', 0) + cnt
            elif 'arm64' in name:
                result['by_arch']['arm64'] = result['by_arch'].get('arm64', 0) + cnt
            result['by_version'][ver] = result['by_version'].get(ver, 0) + cnt
    return result

def _get_local_fpk_versions():
    """扫描 data/apps/ 目录，返回本地现存的 FPK 版本号集合（如 {'0.1.63', '0.1.64', '0.1.65'}）"""
    versions = set()
    apps_dir = os.path.join(DATA_DIR, 'apps')
    if os.path.isdir(apps_dir):
        for fn in os.listdir(apps_dir):
            m = re.match(r'^mmh-(?P<version>\d+\.\d+\.\d+)\.fpk$', fn)
            if m:
                versions.add(m.group('version'))
    return versions

def _github_releases_raw(force_refresh=False):
    """拉取并缓存 GitHub Release 原始列表（10 分钟），供统计页与 /downloads 查找"""
    cached = getattr(flask_app, '_gh_cache', None)
    if not force_refresh and cached and cached.get('raw') and time.time() - cached['time'] < 600:
        return cached.get('raw')
    resp = requests.get(
        f"https://api.github.com/repos/{GITHUB_REPO}/releases?per_page=10",
        headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'fn-appstores-admin'},
        timeout=10,
    )
    resp.raise_for_status()
    releases = resp.json()
    flask_app._gh_cache = {'time': time.time(), 'raw': releases}
    return releases

def lookup_github_asset_url(filename, force_refresh=False):
    """按资产名精确查找 GitHub Release 下载地址；找不到返回 None"""
    try:
        releases = _github_releases_raw(force_refresh=force_refresh)
    except Exception as e:
        print(f"获取 GitHub Release 失败: {e}")
        return None
    if not isinstance(releases, list):
        return None
    for rel in releases:
        for a in rel.get('assets', []):
            if a.get('name') == filename:
                return a.get('browser_download_url')
    return None

# ========== Synology package source protocol ==========

SYNOLOGY_SOURCE_BASE_URL = os.environ.get(
    'SYNOLOGY_SOURCE_BASE_URL', 'https://synology.floatingice.win'
).rstrip('/')


def _is_synology_source_request():
    host = (request.host or '').split(':', 1)[0].lower()
    forwarded_host = (request.headers.get('X-Forwarded-Host') or '').split(',', 1)[0].strip()
    forwarded_host = forwarded_host.split(':', 1)[0].lower()
    return host == 'synology.floatingice.win' or forwarded_host == 'synology.floatingice.win'


def _synology_package_info():
    targets = {}
    downloads_dir = os.path.join(DATA_DIR, 'downloads')
    if os.path.isdir(downloads_dir):
        for filename in os.listdir(downloads_dir):
            match = re.match(r'^mmh-synology-v(?P<version>\d+\.\d+\.\d+)-(?P<arch>x86_64|arm64)\.spk$', filename)
            file_path = os.path.join(downloads_dir, filename)
            if not match or not os.path.isfile(file_path):
                continue
            version = match.group('version')
            arch = match.group('arch')
            current = targets.get(arch)
            if current is None or tuple(map(int, version.split('.'))) > tuple(map(int, current['version'].split('.'))):
                targets[arch] = {
                    'version': version,
                    'filename': filename,
                    'size': os.path.getsize(file_path),
                    'md5': hashlib.md5(open(file_path, 'rb').read()).hexdigest(),
                }
    if not targets:
        return None
    version = max((item['version'] for item in targets.values()), key=lambda value: tuple(map(int, value.split('.'))))
    return version, targets


def _synology_catalog():
    package_info = _synology_package_info()
    if package_info is None:
        return None
    version, targets = package_info
    catalog_targets = {}
    for arch, item in targets.items():
        catalog_targets[arch] = {
            'download_url': f"{SYNOLOGY_SOURCE_BASE_URL}/downloads/{item['filename']}",
            'size': item['size'],
            'md5': item['md5'],
            'md5': item['md5'],
        }
    return {
        'package': 'mmh',
        'version': version,
        'release_tag': f'v{version}',
        'min_dsm_build': 40000,
        'default_language': 'chs',
        'dname': {'chs': 'MMH Home Finance Workspace', 'cht': 'MMH Home Finance Workspace', 'enu': 'MMH Home Finance Workspace'},
        'description': {'chs': 'MMH home finance and asset management package.', 'cht': 'MMH home finance and asset management package.', 'enu': 'MMH home finance and asset management package.'},
        'icon_url': 'https://raw.githubusercontent.com/frankluise5220/MMH/main/public/branding/mmh-logo-pageflip-192.png',
        'snapshot_urls': ['https://raw.githubusercontent.com/frankluise5220/MMH/main/public/branding/mmh-logo-pageflip-192.png'],
        'maintainer': 'frankluise5220',
        'maintainer_url': 'https://github.com/frankluise5220/MMH',
        'distributor': 'MMH',
        'distributor_url': 'https://github.com/frankluise5220/MMH',
        'support_url': 'https://github.com/frankluise5220/MMH/issues',
        'targets': catalog_targets,
        'arch_aliases': {
            'x86_64': ['x86_64', 'x64', 'x86', 'apollolake', 'avoton', 'braswell', 'broadwell', 'broadwellnk', 'bromolow', 'cedarview', 'denverton', 'dockerx64', 'geminilake', 'geminilakenk', 'grantley', 'kvmx64', 'purley', 'r1000', 'r1000nk', 'v1000', 'v1000nk'],
            'arm64': ['aarch64', 'arm64', 'armv8', 'armada37xx', 'cypress', 'rtd1296', 'rtd1619b'],
        },
    }


def _synology_target(catalog, arch):
    value = (arch or '').strip().lower()
    for target, aliases in catalog['arch_aliases'].items():
        if value == target or value in aliases:
            return target
    return None


def _synology_entry(catalog, arch, build, language):
    try:
        build_number = int(build or '')
    except (TypeError, ValueError):
        return None
    if build_number < catalog['min_dsm_build']:
        return None
    target = _synology_target(catalog, arch)
    if not target or target not in catalog['targets']:
        return None
    package_info = catalog['targets'][target]
    return {
        'package': catalog['package'],
        'version': catalog['version'],
        'dname': catalog['dname'].get(language, catalog['dname']['enu']),
        'desc': catalog['description'].get(language, catalog['description']['enu']),
        'link': (
            f"{package_info['download_url']}?arch={request.args.get('arch', arch)}"
            f"&build={request.args.get('build', build)}"
        ),
        'md5': package_info['md5'],
        'thumbnail': [catalog['icon_url']],
        'thumbnail_retina': [catalog['icon_url'], catalog['icon_url']],
        'snapshot': catalog['snapshot_urls'],
        'qinst': True,
        'qupgrade': True,
        'qstart': True,
        'deppkgs': None,
        'conflictpkgs': None,
        'download_count': 0,
        'recent_download_count': 0,
        'startable': 'yes',
        'maintainer': catalog['maintainer'],
        'maintainer_url': catalog['maintainer_url'],
        'distributor': catalog['distributor'],
        'distributor_url': catalog['distributor_url'],
        'support_url': catalog['support_url'],
        'changelog': f"MMH {catalog['version']}",
        'size': package_info['size'],
    }


@flask_app.route('/catalog.json')
def synology_catalog():
    if not _is_synology_source_request():
        return jsonify({'success': False, 'error': 'not found'}), 404
    catalog = _synology_catalog()
    if catalog is None:
        return jsonify({'success': False, 'error': 'package not found'}), 404
    return jsonify(catalog)


@flask_app.route('/', methods=['GET', 'POST'])
def synology_source_root():
    if not _is_synology_source_request():
        return jsonify({'success': False, 'error': 'not found'}), 404
    catalog = _synology_catalog()
    if catalog is None:
        return jsonify({'packages': []})
    arch = request.args.get('arch') or request.form.get('arch')
    build = request.args.get('build') or request.form.get('build')
    language = request.args.get('language') or request.form.get('language')
    if not arch:
        arch = 'x86_64'
    if not build:
        build = str(catalog['min_dsm_build'])
    if not language:
        language = catalog['default_language']
    entry = _synology_entry(catalog, arch, build, language)
    return jsonify({'packages': [entry] if entry else []})


# ================================================================
# ========== 路由 ==========
# ================================================================

@flask_app.route('/api/apps')
def api_apps():
    """返回应用列表"""
    force_refresh = request.args.get('force', 'false').lower() == 'true'
    try:
        apps = get_all_apps(force_refresh=force_refresh)
        return jsonify({"success": True, "data": apps})
    except Exception as e:
        print(f"获取应用列表失败: {e}")
        return jsonify({"success": False, "message": str(e)}), 500

@flask_app.route('/apps/<filename>')
def serve_app(filename):
    """提供 .fpk 下载：记录统计；默认 302 跳转 GitHub Release，不占 VPS 带宽"""
    filepath = os.path.join(DATA_DIR, 'apps', filename)
    exists = os.path.exists(filepath)
    github_url = build_github_download_url(filename)
    if not exists and not github_url:
        return jsonify({'error': '文件不存在'}), 404
    record_download(filename)
    if SERVE_LOCAL_DOWNLOADS:
        if not exists:
            return jsonify({'error': '文件不存在'}), 404
        return send_from_directory(os.path.join(DATA_DIR, 'apps'), filename, as_attachment=True)
    if github_url:
        return redirect(github_url, code=302)
    return send_from_directory(os.path.join(DATA_DIR, 'apps'), filename, as_attachment=True)

@flask_app.route('/downloads/<filename>')
def downloads_redirect(filename):
    """全平台安装包（Synology SPK / Windows EXE/ZIP / APK 等）：
    优先本地直发 data/downloads/<filename>（不经 GitHub），否则计数后 302 到 GitHub Release 资产"""
    if not re.match(r'^[A-Za-z0-9._-]+$', filename) or '..' in filename:
        return jsonify({'error': '文件名不合法'}), 400
    local_path = os.path.join(LOCAL_DOWNLOADS_DIR, filename)
    has_local = os.path.isfile(local_path)
    url = None
    if not has_local:
        url = lookup_github_asset_url(filename, force_refresh=False)
        if url is None:
            url = lookup_github_asset_url(filename, force_refresh=True)
        if url is None:
            return jsonify({'error': '未在本地 downloads 目录或 GitHub Release 资产中找到该文件'}), 404
    record_download(filename)
    if has_local:
        return send_from_directory(LOCAL_DOWNLOADS_DIR, filename, as_attachment=True)
    return redirect(url, code=302)

@flask_app.route('/icons/<filename>')
def serve_icon(filename):
    """提供图标"""
    filepath = os.path.join(DATA_DIR, 'icons', filename)
    if not os.path.exists(filepath):
        return jsonify({'error': '文件不存在'}), 404
    return send_from_directory(os.path.join(DATA_DIR, 'icons'), filename)

@flask_app.route('/previews/<app_id>/<filename>')
def serve_preview(app_id, filename):
    """提供截图"""
    preview_dir = os.path.join(DATA_DIR, 'previews', app_id)
    if not os.path.exists(os.path.join(preview_dir, filename)):
        return jsonify({'error': '文件不存在'}), 404
    return send_from_directory(preview_dir, filename)

@flask_app.route('/health')
@flask_app.route('/fnstore/api/health')
def health():
    """健康检查"""
    return jsonify({"status": "ok", "timestamp": datetime.now(CST).isoformat(timespec='seconds')})

# ================================================================
# ========== 🆕 公告接口 ==========
# ================================================================

@flask_app.route('/api/notice')
def api_notice():
    """获取公告内容"""
    notice_path = os.path.join(DATA_DIR, 'notice.json')
    if os.path.exists(notice_path):
        try:
            with open(notice_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                if 'enabled' not in data:
                    data['enabled'] = True
                return jsonify(data)
        except Exception as e:
            print(f"⚠️ 读取 notice.json 失败: {e}")
            return jsonify({"enabled": False})
    return jsonify({"enabled": False})

# ================================================================
# ========== 🆕 下载统计接口与管理页 ==========
# ================================================================

@flask_app.route('/api/stats')
@flask_app.route('/fnstore/api/stats')
def api_stats():
    """下载统计 + 本地 FPK 文件 + 当前应用元数据（供 4001 管理页消费）"""
    try:
        stats = _load_download_stats()
        files = []
        apps_dir = os.path.join(DATA_DIR, 'apps')
        if os.path.exists(apps_dir):
            for fn in sorted(os.listdir(apps_dir)):
                fp = os.path.join(apps_dir, fn)
                if os.path.isfile(fp):
                    files.append({
                        'name': fn,
                        'size': os.path.getsize(fp),
                        'mtime': datetime.fromtimestamp(os.path.getmtime(fp), tz=CST).strftime('%Y-%m-%d %H:%M:%S'),
                    })
        local_downloads = []
        if os.path.isdir(LOCAL_DOWNLOADS_DIR):
            for fn in sorted(os.listdir(LOCAL_DOWNLOADS_DIR)):
                fp = os.path.join(LOCAL_DOWNLOADS_DIR, fn)
                if os.path.isfile(fp):
                    local_downloads.append({
                        'name': fn,
                        'size': os.path.getsize(fp),
                        'mtime': datetime.fromtimestamp(os.path.getmtime(fp), tz=CST).strftime('%Y-%m-%d %H:%M:%S'),
                    })
        try:
            apps = get_all_apps()
        except Exception as e:
            print(f"⚠️ 统计接口读取应用列表失败: {e}")
            apps = []
        github_summary = _sum_github_downloads()
        # 构建 release × asset-type × channel 矩阵
        # 行 = 文件类型（fnos-x86_64 / fnos-arm64 / synology-x86_64 / synology-arm64 / win-x64 / android）
        # 列 = GitHub / FnDepot / FN软仓 / 群晖 / 飞牛应用中心 / 合计
        all_versions = sorted(_get_local_fpk_versions(), reverse=True)[:5]
        # 确保 GitHub 缓存已填充（api/stats 独立于 api/github-releases 调用）
        try:
            _github_releases_raw(force_refresh=False)
        except Exception:
            pass
        # 从 GitHub API 提取 {ver: {asset-name: download_count}}
        gh_assets = {}
        gh_cache = getattr(flask_app, '_gh_cache', None) or {}
        for _rel in gh_cache.get('raw', []):
            _tag = _rel.get('tag_name', '')
            _ver = _tag.lstrip('v') if _tag else ''
            for _a in _rel.get('assets', []):
                gh_assets.setdefault(_ver, {})[_a['name']] = _a.get('download_count', 0) or 0

        # 从 log 提取 {ver: {file: {source: count}}}
        log_by_file = {}
        for _entry in stats.get('log', []):
            _ver2 = _entry.get('version', '')
            _fname = _entry.get('file', '')
            _src = _entry.get('source', 'vps')
            if _ver2 and _fname:
                log_by_file.setdefault(_ver2, {}).setdefault(_fname, {}).setdefault(_src, 0)
                log_by_file[_ver2][_fname][_src] += 1

        # 渠道：github / fndepot / fnstore / synology / fnos
        # 注：fnos（飞牛应用中心直连 GitHub）VPS 无法统计，始终为 0
        CHS = ['github', 'fndepot', 'fnstore', 'synology', 'fnos']
        CH_LABELS = {'github': 'GitHub', 'fndepot': 'FnDepot', 'fnstore': 'FN软仓', 'synology': '群晖', 'fnos': '飞牛应用中心'}
        CH_TOTAL = 'total'

        def _file_type(name):
            """从文件名推断文件类型"""
            n = name.lower()
            if 'fnos' in n and 'x86_64' in n: return 'fnos-x86_64'
            if 'fnos' in n and 'arm64' in n: return 'fnos-arm64'
            if 'synology' in n and 'x86_64' in n: return 'synology-x86_64'
            if 'synology' in n and 'arm64' in n: return 'synology-arm64'
            if 'win' in n or 'setup' in n or 'x64' in n: return 'win-x64'
            if 'android' in n or 'apk' in n: return 'android'
            if name.endswith('.fpk'): return 'other-fpk'
            return 'other'

        # 收集所有文件类型（排除无意义的 'other'）
        all_types = set()
        for ver in all_versions:
            for name in gh_assets.get(ver, {}):
                ft = _file_type(name)
                if ft != 'other':
                    all_types.add(ft)
        all_types = sorted(all_types)

        sections = {}   # {ver: {matrix: {ft: {ch: count}}, row_totals: {ft}, col_totals: {ch}, grand: n}}
        for ver in all_versions:
            gha = gh_assets.get(ver, {})
            lbf = log_by_file.get(ver, {})
            sec = {'matrix': {}, 'row_totals': {}, 'col_totals': {ch: 0 for ch in CHS}, 'grand': 0}
            for ftype in all_types:
                row = {}
                row_sum = 0
                # GitHub：按资产文件名匹配文件类型
                gh_sum = sum(cnt for name, cnt in gha.items() if _file_type(name) == ftype)
                row['github'] = gh_sum
                row_sum += gh_sum
                sec['col_totals']['github'] += gh_sum
                # VPS 代理来源（fndepot / fnstore / synology）
                for ch in ['fndepot', 'fnstore', 'synology']:
                    ch_sum = 0
                    for fname, sources in lbf.items():
                        if _file_type(fname) == ftype:
                            # 通用 FPK 文件名（other-fpk）或直接匹配的文件名
                            ch_sum += sources.get(ch, 0)
                        elif _file_type(fname) == 'other-fpk' and ftype == 'fnos-x86_64':
                            # FPK 下载无法区分平台，默认归属 fnos-x86_64
                            ch_sum += sources.get(ch, 0)
                    row[ch] = ch_sum
                    row_sum += ch_sum
                    sec['col_totals'][ch] += ch_sum
                # fnos 渠道（飞牛应用中心直连 GitHub，VPS 无法统计）
                row['fnos'] = 0
                sec['col_totals']['fnos'] += 0
                row[CH_TOTAL] = row_sum
                sec['grand'] += row_sum
                sec['matrix'][ftype] = row
            # 每行（文件类型）合计
            for ftype in all_types:
                sec['row_totals'][ftype] = sum(
                    sec['matrix'].get(ftype, {}).get(ch, 0) for ch in CHS
                )
            sections[ver] = sec

        # 全局合计
        grand_total = sum(s.get('grand', 0) for s in sections.values())
        grand_col_totals = {ch: sum(s['col_totals'].get(ch, 0) for s in sections.values()) for ch in CHS}
        grand_col_totals[CH_TOTAL] = grand_total
        grand_row_totals = {}  # {ft: 总计}
        for ftype in all_types:
            grand_row_totals[ftype] = sum(s['row_totals'].get(ftype, 0) for s in sections.values())

        return jsonify({
            'success': True,
            'time': datetime.now(CST).isoformat(timespec='seconds'),
            'mode': 'local' if SERVE_LOCAL_DOWNLOADS else 'redirect',
            'github_repo': GITHUB_REPO,
            'stats': stats,
            'versions': all_versions,
            'file_types': all_types,
            'sections': sections,         # {ver: {matrix, row_totals, col_totals, grand}}
            'grand_total': grand_total,
            'grand_col_totals': grand_col_totals,
            'grand_row_totals': grand_row_totals,
            'ch_list': CHS,
            'by_day': stats.get('by_day', {}),
            'files': files,
            'local_downloads': local_downloads,
            'apps': apps,
        })
    except Exception as e:
        print(f"获取下载统计失败: {e}")
        return jsonify({"success": False, "message": str(e)}), 500

@flask_app.route('/api/github-releases')
@flask_app.route('/fnstore/api/github-releases')
def api_github_releases():
    """代理 GitHub Release 资产列表与下载量（服务端缓存 10 分钟，避免浏览器直连 GitHub 受限）。
    只返回 VPS 本地 apps/ 目录中现存版本对应的 Release（旧版本不展示）。"""
    cached = getattr(flask_app, '_gh_cache', None)
    if cached and cached.get('raw') and cached.get('trimmed') and time.time() - cached['time'] < 600:
        return jsonify(cached['trimmed'])
    try:
        releases = _github_releases_raw(force_refresh=False)
    except Exception as e:
        print(f"获取 GitHub Release 失败: {e}")
        return jsonify({"success": False, "message": str(e)}), 502
    local_versions = _get_local_fpk_versions()
    trimmed = []
    for rel in releases:
        tag = rel.get('tag_name', '')
        ver = tag.lstrip('v') if tag else ''
        if ver not in local_versions:
            continue
        trimmed.append({
            'tag': tag,
            'published_at': (rel.get('published_at') or '')[:10],
            'assets': [
                {'name': a.get('name'), 'size': a.get('size'), 'download_count': a.get('download_count')}
                for a in rel.get('assets', [])
            ],
        })
    payload = {"success": True, "releases": trimmed}
    cached = getattr(flask_app, '_gh_cache', None)
    if cached is not None:
        cached['trimmed'] = payload
    return jsonify(payload)

@flask_app.route('/fnstore')
@flask_app.route('/fnstore/')
def fnstore_admin():
    """软仓源管理页（4001 nginx 反代到本路由；数据来自 /fnstore/api/*）"""
    if os.path.exists(ADMIN_HTML_PATH):
        return send_from_directory(os.path.join(DATA_DIR, 'admin'), 'index.html')
    return jsonify({'error': '管理页未部署：缺少 data/admin/index.html'}), 404

# ================================================================
# ========== 启动 ==========
# ================================================================

# ================================================================
# MMH 下载统计覆盖层（2026-09-29 加入）
# 用统一事件存储（stats_store -> data/mmh-stats.db）替换原先的 download-stats.json 计数器。
# 覆盖 record_download 与 api_stats，具体逻辑见 app/mmh_stats_override.py。
# ================================================================
import mmh_stats_override
mmh_stats_override.install(globals())


if __name__ == '__main__':
    print(f"✅ FN软仓 服务端启动在端口 {PORT}")
    print(f"📂 数据目录: {DATA_DIR}")
    print(f"🧭 管理页: http://<host>:{PORT}/fnstore/（分发模式: {'local' if SERVE_LOCAL_DOWNLOADS else 'redirect'}）")
    
    # 检查数据目录
    if not os.path.exists(DATA_DIR):
        print(f"⚠️ 数据目录不存在: {DATA_DIR}")
    else:
        json_path = os.path.join(DATA_DIR, 'fn-appstores.json')
        if os.path.exists(json_path):
            print(f"✅ fn-appstores.json 存在")
        else:
            print(f"⚠️ fn-appstores.json 不存在")
        
        # 检查公告文件
        notice_path = os.path.join(DATA_DIR, 'notice.json')
        if os.path.exists(notice_path):
            print(f"✅ notice.json 存在")
        else:
            print(f"ℹ️ notice.json 不存在（可选）")
        
        # 检查管理页
        if os.path.exists(ADMIN_HTML_PATH):
            print(f"✅ 管理页 admin/index.html 存在")
        else:
            print(f"ℹ️ 管理页 admin/index.html 不存在（可选）")
    
    flask_app.run(host='0.0.0.0', port=PORT, debug=False)
