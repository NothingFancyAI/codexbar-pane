import os
import sqlite3
import json
import sys
import shutil
import string
import glob
import base64

# Dependencies
try:
    import secretstorage
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    HAS_DEPS = True
except ImportError:
    HAS_DEPS = False

def get_key(label_hint):
    try:
        bus = secretstorage.dbus_init()
        collection = secretstorage.get_default_collection(bus)
        for item in collection.get_all_items():
            if label_hint.lower() in item.get_label().lower():
                return item.get_secret()
    except:
        pass
    return b"peanuts"

def decrypt_v10(encrypted_value, key):
    if not encrypted_value or len(encrypted_value) < 3:
        return None
        
    if not encrypted_value.startswith(b"v10") and not encrypted_value.startswith(b"v11"):
        return None
        
    try:
        salt = b"saltysalt"
        iv = b" " * 16
        kdf = PBKDF2HMAC(algorithm=hashes.SHA1(), length=16, salt=salt, iterations=1)
        derived_key = kdf.derive(key)
        
        cipher = Cipher(algorithms.AES(derived_key), modes.CBC(iv))
        decryptor = cipher.decryptor()
        decrypted = decryptor.update(encrypted_value[3:]) + decryptor.finalize()
        
        # Unpadding check
        padding_len = decrypted[-1]
        if 0 < padding_len <= 16:
            if all(decrypted[i] == padding_len for i in range(-padding_len, 0)):
                decrypted_unpadded = decrypted[:-padding_len]
            else:
                decrypted_unpadded = decrypted
        else:
            decrypted_unpadded = decrypted

        # Handle v11 / v10 header/garbage
        # Try to find JWT start
        jwt_start = decrypted.find(b'eyJ')
        if jwt_start != -1 and jwt_start < 48:
            res = decrypted[jwt_start:]
        else:
            # Try common header offsets for v11
            found_clean = False
            for offset in [32, 28, 0]:
                if len(decrypted) > offset:
                    candidate = decrypted[offset:]
                    # Check if the first 10 chars are printable (ASCII)
                    if len(candidate) >= 10 and all(32 <= c <= 126 for c in candidate[:10]):
                        res = candidate
                        found_clean = True
                        break
            if not found_clean:
                res = decrypted_unpadded

        # Final cleanup: decode and handle padding/garbage
        s = res.decode('utf-8', errors='ignore')
        import re
        
        # Valid characters for JWT and NextAuth tokens (base64url, plus common punctuation just in case)
        # Next.js Auth chunked tokens can end in arbitrary base64 characters.
        valid_chars = set(string.ascii_letters + string.digits + "-_.~%|=/+")
        
        # We should NOT include newline or carriage return in our extraction
        s = re.sub(r'[\r\n\t]+', '', s)
        
        start = 0
        while start < len(s) and s[start] not in valid_chars:
            start += 1
            
        end = len(s)
        while end > start and s[end-1] not in valid_chars:
            end -= 1
            
        res_str = s[start:end]
        
        # Additional safety: ensure no control characters
        res_str = ''.join(c for c in res_str if ord(c) >= 32 and ord(c) < 127)
        
        if not res_str:
            return None
            
        return res_str
    except:
        return None

def extract_tokens():
    if not HAS_DEPS:
        return {"error": "DEPENDENCIES_MISSING"}

    browsers = [
        {"name": "Chrome", "path": "~/.config/google-chrome/*/Cookies", "key_label": "Chrome Safe Storage"},
        {"name": "Brave", "path": "~/.config/BraveSoftware/Brave-Browser/*/Cookies", "key_label": "Brave Safe Storage"},
        {"name": "Chromium", "path": "~/.config/chromium/*/Cookies", "key_label": "Chromium Safe Storage"},
    ]

    # Target cookies (broaden to ensure session validity)
    targets = ["session-token", "oai-did", "oai-sc", "cf_clearance", "_cf_bm", "oai-is", "oai-allow", "oai-chat-web-route", "oai-client-auth-info"]
    
    all_cookies = {}
    
    for browser in browsers:
        key = get_key(browser["key_label"])
        search_path = os.path.expanduser(browser["path"])
        cookie_files = glob.glob(search_path)
        
        for db_path in cookie_files:
            try:
                temp_db = f"/tmp/codexbar_cookies_{os.getpid()}.db"
                shutil.copyfile(db_path, temp_db)
                conn = sqlite3.connect(f"file:{temp_db}?mode=ro", uri=True)
                cursor = conn.cursor()
                
                cursor.execute("SELECT name, encrypted_value FROM cookies WHERE host_key LIKE '%chatgpt.com%' OR host_key LIKE '%openai.com%'")
                
                for name, enc_val in cursor.fetchall():
                    if not any(t in name for t in targets):
                        continue
                    
                    decrypted = decrypt_v10(enc_val, key)
                    if decrypted is None and key != b"peanuts":
                        decrypted = decrypt_v10(enc_val, b"peanuts")
                    
                    if decrypted:
                        all_cookies[name] = decrypted
                
                conn.close()
                if os.path.exists(temp_db): os.remove(temp_db)
            except:
                if os.path.exists(temp_db): os.remove(temp_db)
                continue

    if not all_cookies:
        return {"error": "SESSION_NOT_FOUND", "details": "Found no valid session tokens. Please ensure you are logged in."}

    found_session = any("session-token" in name for name in all_cookies)
    if not found_session:
         return {"error": "SESSION_NOT_FOUND", "details": "Found some cookies but no session token. Please log in."}

    # Format the cookie header
    # Priority: session-token, then others
    session_parts = [f"{name}={val}" for name, val in sorted(all_cookies.items()) if "session-token" in name]
    other_parts = [f"{name}={val}" for name, val in sorted(all_cookies.items()) if "session-token" not in name]
    
    cookie_parts = session_parts + other_parts
    
    # GNOME/Gtk/D-Bus limits: If the string is too long, it might fail to pass through some channels.
    # 4KB is a safe bet for many systems, though D-Bus allows much more.
    # Let's see if we can fit it.
    header = "; ".join(cookie_parts)
    if len(header) > 8192:
        # If still too long, we might need to be more aggressive, but session-token is vital.
        # Let's just return what we have for now and hope for the best.
        pass
        
    return {"cookie_header": header}

if __name__ == "__main__":
    try:
        print(json.dumps(extract_tokens()))
    except Exception as e:
        print(json.dumps({"error": "UNEXPECTED_EXCEPTION", "details": str(e)}))
