# ══ tests/manual/：要**外部依赖**的手动套件（20261003 从 tests/frontend_contract/ 挪来）══
# 目录名就是判据：这里的套件跑起来要一个**活着的服务**（本文件要 3000 端口的真后端、
# 登录类用例还要真凭据），所以 `cargo test` 与 CI 都不带它们。自动化的那两批在别处：
# `tests/api_tests.rs` + `tests/mysql_integration.rs`（跟着 `cargo test` 跑）、
# `frontend/tests/*.test.mjs`（`npm test`，进 CI）。
# 判据的完整清单与"哪一层跑什么"见 CONTRIBUTING.md §3。
import warnings
warnings.filterwarnings("ignore")

import os
import requests
import unittest
import json

BASE_URL = "http://localhost:3000"

# 账号口令**不进仓库**（20260930）。此前这里是写死的真实账号（本站在用的那一个），
# 仓库一公开就等于把凭据一起发了。要跑这套手动契约测试，自己把凭据给进来：
#     BLOG_TEST_USER=... BLOG_TEST_PASSWORD=... python3 tests/manual/test_api.py
# 不给也照跑：需要登录的用例自动跳过，公开路由那部分不受影响（**本文件不在 CI 里**，
# 是手动跑的契约测试——正因如此，写死一个口令在这里没人会发现）。
TEST_USER = os.environ.get("BLOG_TEST_USER", "")
TEST_PASSWORD = os.environ.get("BLOG_TEST_PASSWORD", "")
HAVE_CREDS = bool(TEST_USER and TEST_PASSWORD)

class TestFrontendContract(unittest.TestCase):

    def setUp(self):
        self.session = requests.Session()
        # Login to get token for protected routes
        try:
            res = self.session.post(f"{BASE_URL}/api/login", json={
                "username": TEST_USER,
                "password": TEST_PASSWORD
            })
            if res.status_code == 200:
                self.token = res.json().get("data")
                self.session.headers.update({"Authorization": self.token})
            else:
                self.token = None
                print("Login failed, protected tests might fail.")
        except Exception as e:
            self.token = None
            print(f"Login exception: {e}")

    # --- Public Routes ---

    @unittest.skipUnless(HAVE_CREDS, "未提供 BLOG_TEST_USER / BLOG_TEST_PASSWORD")
    def test_login(self):
        """Test POST /api/login"""
        res = requests.post(f"{BASE_URL}/api/login", json={
            "username": TEST_USER,
            "password": TEST_PASSWORD
        })
        self.assertEqual(res.status_code, 200, "Login should succeed")
        self.assertIn("data", res.json(), "Response should contain data (token)")

    def test_public_user_info(self):
        """Test GET /api/public/user"""
        res = requests.get(f"{BASE_URL}/api/public/user")
        self.assertEqual(res.status_code, 200)
        data = res.json().get("data")
        # Check required fields from Frontend 'UserState'
        # userinfo.data.data.userAvatar
        self.assertIn("userAvatar", data)
        self.assertIn("userTalk", data)
        self.assertIn("blogAuthor", data)
        self.assertIn("blogTitle", data)

    def test_public_social_info(self):
        """Test GET /api/public/social"""
        res = requests.get(f"{BASE_URL}/api/public/social")
        self.assertEqual(res.status_code, 200)
        # Frontend expects social.data.data
        data = res.json().get("data")
        self.assertIsInstance(data, dict)

    def test_public_categories(self):
        """Test GET /api/public/category"""
        res = requests.get(f"{BASE_URL}/api/public/category")
        self.assertEqual(res.status_code, 200)
        data = res.json().get("data")
        self.assertIsInstance(data, list)
        if len(data) > 0:
            item = data[0]
            # Verify fields used in Head/index.tsx
            # categoryKey, pathName, icon, categoryTitle
            self.assertIn("categoryKey", item)
            self.assertIn("pathName", item)
            self.assertIn("icon", item)
            self.assertIn("categoryTitle", item)

    def test_public_notes_list(self):
        """Test GET /api/public/notes"""
        res = requests.get(f"{BASE_URL}/api/public/notes")
        self.assertEqual(res.status_code, 200)
        data = res.json().get("data")
        self.assertIsInstance(data, list)
    
    def test_public_top_notes(self):
        """Test GET /api/public/topnotes"""
        res = requests.get(f"{BASE_URL}/api/public/topnotes")
        self.assertEqual(res.status_code, 200)
        data = res.json().get("data")
        self.assertIsInstance(data, list)

    def test_search_notes_by_keyword(self):
        """Test POST /api/public/notes/search with keyword"""
        res = requests.post(f"{BASE_URL}/api/public/notes/search", json={
            "keyword": "Test"
        })
        self.assertEqual(res.status_code, 200)
        data = res.json().get("data")
        self.assertIsInstance(data, list)

    def test_search_notes_by_category(self):
        """Test POST /api/public/notes/search with categories (The Fix)"""
        # Frontend Sends: { categories: title.categoryTitle, status: 'public' }
        res = requests.post(f"{BASE_URL}/api/public/notes/search", json={
            "categories": "Backend", # Assuming 'Backend' category exists or just checking 200 OK
            "status": "public"
        })
        self.assertEqual(res.status_code, 200, "Search by categories should return 200")
        data = res.json().get("data")
        self.assertIsInstance(data, list, "Search result should be a list")

    def test_public_tags(self):
        """Test GET /api/public/tagone & tagtwo"""
        res1 = requests.get(f"{BASE_URL}/api/public/tagone")
        self.assertEqual(res1.status_code, 200, "TagOne should work")
        
        res2 = requests.get(f"{BASE_URL}/api/public/tagtwo")
        self.assertEqual(res2.status_code, 200, "TagTwo should work")

    def test_public_friends(self):
        """Test GET /api/public/friends"""
        res = requests.get(f"{BASE_URL}/api/public/friends")
        self.assertEqual(res.status_code, 200)
        
    def test_public_talks(self):
        """Test GET /api/public/talk"""
        res = requests.get(f"{BASE_URL}/api/public/talk")
        self.assertEqual(res.status_code, 200)

    # --- Protected Routes (Requires Token) ---
    
    def test_auth_check(self):
        """Test GET /api/login/auth"""
        if not self.token: self.skipTest("No token")
        res = self.session.get(f"{BASE_URL}/api/login/auth")
        self.assertEqual(res.status_code, 200, "Auth check should pass with token")

if __name__ == '__main__':
    unittest.main()
