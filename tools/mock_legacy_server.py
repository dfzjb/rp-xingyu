# -*- coding: utf-8 -*-
"""本地黑盒测试用 Mock 旧版：迁移接口 + 假 OpenAI 兼容 API + 静态托管 dist/

用法:  python mock_legacy_server.py [--port 8010]
  - POST /api/migrate/export   接受 {email,password} / {api_key} / 空body(Cookie模式)，返回夹具全量键值
  - POST /api/migrate/purge    校验 key_count 后把夹具目录移入 test_fixture/.trash（模拟即刻删除）
  - GET  /v1/models            返回假模型列表
  - POST /v1/chat/completions  流式假回复（含 <think> 思维链 + markdown）
  - 其余路径                   托管 ../dist/
"""
import argparse
import json
import os
import re
import shutil
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
FIXTURE_DIR = os.path.join(BASE, 'test_fixture', 'user_data')
TRASH_DIR = os.path.join(BASE, 'test_fixture', '.trash')
DIST_DIR = os.path.normpath(os.path.join(BASE, '..', 'dist'))

MOCK_REPLY = (
    "<think>用户提到了海边，我应该把场景引向海风酒馆，"
    "保持第二人称叙述，注意不要替用户做决定。</think>"
    "\n\n夜色像一层薄绸，缓缓覆在海面上。\n\n"
    "「你来得正好。」**她**把一枚铜钥匙推过柜台，指尖在灯下泛着微光。\n\n"
    "- 二楼尽头的房间还空着\n- 桌上的信没有拆\n\n"
    "> 要上去看看吗？还是先喝一杯？\n\n"
    "```python\nprint('hello 星屿')  # 代码高亮测试\n```"
)


class MockHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIST_DIR, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

    def _json(self, obj, code=200):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()
        self.wfile.write(json.dumps(obj, ensure_ascii=False).encode('utf-8'))

    def _load_keys(self):
        keys = {}
        for f in os.listdir(FIXTURE_DIR):
            if f.endswith('.json'):
                try:
                    keys[f[:-5]] = json.load(open(os.path.join(FIXTURE_DIR, f), encoding='utf-8'))
                except Exception:
                    pass
        return keys

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        try:
            body = json.loads(self.rfile.read(length)) if length else {}
        except json.JSONDecodeError:
            body = {}

        if self.path == '/api/migrate/export':
            # 模拟身份验证：账号模式要求非空凭据；Cookie 模式空 body 放行
            if body.get('email') or body.get('api_key'):
                account = body.get('email') or ('sk-' + body['api_key'][:6] + '…')
            elif not body:
                account = 'cookie-user'
            else:
                self._json({'error': '邮箱或密码错误'}, 400)
                return
            keys = self._load_keys()
            # 模拟 df_api_account.json（服务端存的密钥文件，客户端会带入设置）
            keys['df_api_account'] = {'email': account, 'api_key': 'sk-mock-test-key-1234567890', 'created_at': 1756000000}
            self._json({'ok': True, 'account': account, 'key_count': len(keys), 'keys': keys})
            return

        if self.path == '/api/migrate/purge':
            if FIXTURE_DIR != os.path.normpath(FIXTURE_DIR) or not os.path.isdir(FIXTURE_DIR):
                self._json({'error': '目录不存在（可能已删除）'}, 404)
                return
            n_files = len([f for f in os.listdir(FIXTURE_DIR) if f.endswith('.json')])
            if body.get('key_count') != n_files:
                self._json({'error': f'键数校验失败：本地报 {body.get("key_count")}，服务器实际 {n_files}'}, 409)
                return
            os.makedirs(TRASH_DIR, exist_ok=True)
            dst = os.path.join(TRASH_DIR, f'purged_{int(time.time())}')
            shutil.move(FIXTURE_DIR, dst)
            self._json({'ok': True, 'deleted_files': n_files})
            return

        if self.path == '/v1/chat/completions':
            stream = body.get('stream', False)
            if not stream:
                self._json({'choices': [{'message': {'role': 'assistant', 'content': MOCK_REPLY}}]})
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            chunks = [MOCK_REPLY[i:i + 24] for i in range(0, len(MOCK_REPLY), 24)]
            for c in chunks:
                data = {'choices': [{'delta': {'content': c}}]}
                self.wfile.write(f'data: {json.dumps(data, ensure_ascii=False)}\n\n'.encode('utf-8'))
                self.wfile.flush()
                time.sleep(0.05)
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()
            return

        self._json({'error': 'not found'}, 404)

    def do_GET(self):
        if self.path == '/v1/models':
            self._json({'data': [{'id': m} for m in ['mock-rp-model', 'mock-rp-model-pro', 'glm-4.7']]})
            return
        if self.path == '/api/dev/fixture-keys':
            keys = self._load_keys()
            keys['df_api_account'] = {'email': 'fixture@test', 'api_key': 'sk-mock-test-key-1234567890', 'created_at': 1756000000}
            self._json({'ok': True, 'account': 'fixture', 'keys': keys})
            return
        if self.path == '/plaza/index.json':
            cards = [
                {
                    'name': '海风酒馆·老板娘',
                    'description': '滨海小城老酒馆的老板娘，沉默寡言但心思细腻。',
                    'tags': ['原创', '都市', '治愈'],
                    'url': '/plaza/card/tavern-keeper.json',
                },
                {
                    'name': '时间冻结的法师学徒',
                    'description': '圣冠王国的法师学徒，觉醒了冻结时间的异能。',
                    'tags': ['奇幻', '冒险'],
                    'url': '/plaza/card/frost-mage.json',
                },
            ]
            self._json(cards)
            return
        m = re.match(r'^/plaza/card/([a-z0-9-]+)\.json$', self.path)
        if m:
            cards_db = {
                'tavern-keeper': {
                    'spec': 'chara_card_v3', 'spec_version': '3.0',
                    'data': {
                        'name': '海风酒馆·老板娘',
                        'description': '{{char}} 是滨海小城「海风酒馆」的老板娘。沉默寡言，心思细腻，总能记住每位客人的故事。深夜打烊后，她会为还留在店里的客人温一壶热酒。',
                        'personality': '外冷内热；话少但观察入微；讨厌麻烦却心软。',
                        'scenario': '暴雨夜，{{user}} 推开了酒馆的门。',
                        'first_mes': '夜色像一层薄绸覆在海面上。\n\n「你来得正好。」**她**把一枚铜钥匙推过柜台。\n\n> 要上去看看吗？还是先喝一杯？',
                        'creator_notes': '示例卡：用于本地联调广场功能。',
                        'avatar': 'none',
                        'character_book': {'entries': [
                            {'keys': ['酒馆', '海边'], 'content': '【海风酒馆】小城中心的老酒馆，木地板会吱呀作响。', 'enabled': True, 'comment': '地点'},
                        ]},
                        'extensions': {'legacy_watermark': 'rp-site'},
                    },
                },
                'frost-mage': {
                    'spec': 'chara_card_v3', 'spec_version': '3.0',
                    'data': {
                        'name': '时间冻结的法师学徒',
                        'description': '{{char}} 是圣冠王国的法师学徒，觉醒了冻结时间的稀有异能，因此被王室监视。',
                        'personality': '好奇心旺盛；对时间流逝有异于常人的执着；害怕孤独。',
                        'scenario': '钟楼顶，{{char}} 正在偷偷练习能力，被 {{user}} 撞见。',
                        'first_mes': '钟摆停在了半空。\n\n「……你、你看见了？」少年猛地转身，指尖还悬着一粒静止的雨滴。\n\n别告诉任何人。',
                        'creator_notes': '示例卡：用于本地联调广场功能。',
                        'avatar': 'none',
                        'character_book': {},
                        'extensions': {'legacy_watermark': 'rp-site'},
                    },
                },
            }
            key = m.group(1)
            if key not in cards_db:
                self._json({'error': 'not found'}, 404)
                return
            self._json(cards_db[key])
            return
        if self.path == '/sse-test' or self.path == '/sse-test.html':
            html = open(os.path.join(BASE, 'sse_test_page.html'), 'rb').read()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(html)
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        path = args[0] if args else ''
        if isinstance(path, str) and any(s in path for s in ('.js', '.css', '.woff', '.png', '.svg')):
            return
        print('[mock]', fmt % args)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8010)
    args = ap.parse_args()
    if not os.path.isdir(DIST_DIR):
        raise SystemExit('dist/ 不存在，请先 npx vite build')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), MockHandler)
    print(f'Mock legacy server: http://127.0.0.1:{args.port}/')
    print(f'  fixture: {FIXTURE_DIR}')
    print(f'  dist:    {DIST_DIR}')
    server.serve_forever()


if __name__ == '__main__':
    main()
