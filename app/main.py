"""flightlog - a small self-hosted pilot logbook.

Public, read-only view of the logbook. Adding, editing and deleting flights
requires Google sign-in with an allow-listed email address.
"""
import csv
import io
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from starlette.middleware.sessions import SessionMiddleware

BASE = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("FLIGHTLOG_DB", BASE / "flightlog.db"))
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
ALLOWED_EMAILS = {e.strip().lower() for e in os.environ.get("ALLOWED_EMAILS", "").split(",") if e.strip()}
SECRET_KEY = os.environ.get("SECRET_KEY", "")
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "true").lower() != "false"
SITE_TITLE = os.environ.get("SITE_TITLE", "Flight Log")
HOME_AIRPORT = os.environ.get("HOME_AIRPORT", "").upper()
SITE_FOOTER = os.environ.get("SITE_FOOTER", "")
# Link to the source code in the footer; set SOURCE_URL= (empty) to hide it
SOURCE_URL = os.environ.get("SOURCE_URL", "https://github.com/jbzambon/flightlog")
SEED_FILE = Path(os.environ.get("SEED_FILE", BASE / "seed_flights.json"))
# Fields hidden from signed-out visitors (other people's names/cert numbers, private notes)
PUBLIC_HIDDEN = [f.strip() for f in os.environ.get("PUBLIC_HIDDEN_FIELDS", "instructor,notes").split(",") if f.strip()]

if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY must be set (see .env.example)")

NUM_FIELDS = ["day_to", "night_to", "day_ldg", "night_ldg", "approaches",
              "se", "me", "xc", "night", "actual", "hood", "pic", "dual", "ground", "total"]
TEXT_FIELDS = ["aircraft_type", "tail", "dep", "arr", "via", "instructor", "remarks", "notes"]
ALL_FIELDS = ["date"] + TEXT_FIELDS + NUM_FIELDS + ["page", "flight_review"]

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS flights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    {", ".join(f"{f} TEXT" for f in TEXT_FIELDS)},
    {", ".join(f"{f} REAL" for f in NUM_FIELDS)},
    page INTEGER,
    flight_review INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_flights_date ON flights(date);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT DEFAULT CURRENT_TIMESTAMP,
    email TEXT, action TEXT, flight_id INTEGER, before TEXT, after TEXT
);
"""


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.executescript(SCHEMA)
        if conn.execute("SELECT COUNT(*) FROM flights").fetchone()[0] == 0:
            seed = SEED_FILE
            if seed.exists():
                for row in json.loads(seed.read_text()):
                    vals = {f: row.get(f) for f in ALL_FIELDS}
                    vals["flight_review"] = int(bool(row.get("flight_review")))
                    cols = ", ".join(vals)
                    conn.execute(f"INSERT INTO flights ({cols}) VALUES ({', '.join('?' * len(vals))})",
                                 list(vals.values()))


class Flight(BaseModel):
    date: str
    aircraft_type: Optional[str] = Field(None, max_length=40)
    tail: Optional[str] = Field(None, max_length=12)
    dep: Optional[str] = Field(None, max_length=8)
    arr: Optional[str] = Field(None, max_length=8)
    via: Optional[str] = Field(None, max_length=80)
    instructor: Optional[str] = Field(None, max_length=120)
    remarks: Optional[str] = Field(None, max_length=1000)
    notes: Optional[str] = Field(None, max_length=1000)
    day_to: Optional[float] = Field(None, ge=0, le=99)
    night_to: Optional[float] = Field(None, ge=0, le=99)
    day_ldg: Optional[float] = Field(None, ge=0, le=99)
    night_ldg: Optional[float] = Field(None, ge=0, le=99)
    approaches: Optional[float] = Field(None, ge=0, le=99)
    se: Optional[float] = Field(None, ge=0, le=24)
    me: Optional[float] = Field(None, ge=0, le=24)
    xc: Optional[float] = Field(None, ge=0, le=24)
    night: Optional[float] = Field(None, ge=0, le=24)
    actual: Optional[float] = Field(None, ge=0, le=24)
    hood: Optional[float] = Field(None, ge=0, le=24)
    pic: Optional[float] = Field(None, ge=0, le=24)
    dual: Optional[float] = Field(None, ge=0, le=24)
    ground: Optional[float] = Field(None, ge=0, le=24)
    total: float = Field(..., gt=0, le=24)
    page: Optional[int] = Field(None, ge=0, le=9999)
    flight_review: bool = False

    @field_validator("date")
    @classmethod
    def valid_date(cls, v):
        date.fromisoformat(v)
        return v

    @field_validator(*TEXT_FIELDS)
    @classmethod
    def blank_to_none(cls, v):
        if v is None:
            return None
        v = v.strip()
        return v or None

    @field_validator("tail", "dep", "arr")
    @classmethod
    def upper(cls, v):
        return v.upper() if v else v


class Medical(BaseModel):
    """Only what's needed to compute expiration: no DOB, address, or certificate numbers."""
    medical_class: Optional[int] = Field(None, ge=1, le=3)
    medical_exam_date: Optional[str] = None
    medical_under_40: bool = False

    @field_validator("medical_exam_date")
    @classmethod
    def valid_exam_date(cls, v):
        if v:
            date.fromisoformat(v)
        return v or None


def get_medical(conn) -> dict:
    s = dict(conn.execute("SELECT key, value FROM settings WHERE key LIKE 'medical_%'").fetchall())
    if not s.get("medical_exam_date"):
        return {}
    return {"medical_class": int(s.get("medical_class") or 3), "medical_exam_date": s["medical_exam_date"],
            "medical_under_40": s.get("medical_under_40") == "1"}


app = FastAPI(title=SITE_TITLE, docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY, session_cookie="flightlog_session",
                   max_age=60 * 60 * 24 * 30, same_site="strict", https_only=COOKIE_SECURE)
init_db()


def row_to_dict(r):
    d = dict(r)
    d["flight_review"] = bool(d["flight_review"])
    return d


def current_editor(request: Request) -> str:
    email = request.session.get("email")
    if not email or email not in ALLOWED_EMAILS:
        raise HTTPException(401, "Sign in to edit")
    # CSRF guard on top of SameSite=strict cookies: browsers won't send this header cross-site
    if request.method != "GET" and request.headers.get("x-flightlog") != "1":
        raise HTTPException(403, "Missing request header")
    return email


@app.get("/api/config")
def config(request: Request):
    email = request.session.get("email")
    with db() as conn:
        medical = get_medical(conn)
    return {"medical": medical, "title": SITE_TITLE, "google_client_id": GOOGLE_CLIENT_ID, "home_airport": HOME_AIRPORT, "footer": SITE_FOOTER, "source_url": SOURCE_URL,
            "editor": bool(email and email in ALLOWED_EMAILS), "email": email}


@app.post("/api/login")
async def login(request: Request):
    from google.auth.transport import requests as g_requests
    from google.oauth2 import id_token

    body = await request.json()
    try:
        info = id_token.verify_oauth2_token(body.get("credential", ""), g_requests.Request(), GOOGLE_CLIENT_ID)
    except Exception:
        raise HTTPException(401, "Invalid Google sign-in")
    email = (info.get("email") or "").lower()
    if not info.get("email_verified") or email not in ALLOWED_EMAILS:
        raise HTTPException(403, "This Google account can't edit this logbook")
    request.session["email"] = email
    return {"editor": True, "email": email}


@app.post("/api/logout")
def logout(request: Request):
    request.session.clear()
    return {"editor": False}


def is_editor(request: Request) -> bool:
    email = request.session.get("email")
    return bool(email and email in ALLOWED_EMAILS)


def public_view(d: dict, request: Request) -> dict:
    if not is_editor(request):
        for f in PUBLIC_HIDDEN:
            d.pop(f, None)
    return d


@app.get("/api/flights")
def list_flights(request: Request):
    with db() as conn:
        rows = conn.execute("SELECT * FROM flights ORDER BY date, id").fetchall()
    return [public_view(row_to_dict(r), request) for r in rows]


def _audit(conn, email, action, fid, before, after):
    conn.execute("INSERT INTO audit (email, action, flight_id, before, after) VALUES (?,?,?,?,?)",
                 (email, action, fid, json.dumps(before) if before else None, json.dumps(after) if after else None))


@app.post("/api/flights", status_code=201)
def add_flight(f: Flight, email: str = Depends(current_editor)):
    vals = f.model_dump()
    vals["flight_review"] = int(vals["flight_review"])
    with db() as conn:
        cur = conn.execute(f"INSERT INTO flights ({', '.join(vals)}) VALUES ({', '.join('?' * len(vals))})",
                           list(vals.values()))
        fid = cur.lastrowid
        _audit(conn, email, "create", fid, None, vals)
        row = conn.execute("SELECT * FROM flights WHERE id=?", (fid,)).fetchone()
    return row_to_dict(row)


@app.put("/api/flights/{fid}")
def update_flight(fid: int, f: Flight, email: str = Depends(current_editor)):
    vals = f.model_dump()
    vals["flight_review"] = int(vals["flight_review"])
    with db() as conn:
        before = conn.execute("SELECT * FROM flights WHERE id=?", (fid,)).fetchone()
        if not before:
            raise HTTPException(404, "Flight not found")
        conn.execute(f"UPDATE flights SET {', '.join(f'{k}=?' for k in vals)}, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                     list(vals.values()) + [fid])
        _audit(conn, email, "update", fid, dict(before), vals)
        row = conn.execute("SELECT * FROM flights WHERE id=?", (fid,)).fetchone()
    return row_to_dict(row)


@app.delete("/api/flights/{fid}")
def delete_flight(fid: int, email: str = Depends(current_editor)):
    with db() as conn:
        before = conn.execute("SELECT * FROM flights WHERE id=?", (fid,)).fetchone()
        if not before:
            raise HTTPException(404, "Flight not found")
        conn.execute("DELETE FROM flights WHERE id=?", (fid,))
        _audit(conn, email, "delete", fid, dict(before), None)
    return {"deleted": fid}


@app.put("/api/settings/medical")
def update_medical(med: Medical, email: str = Depends(current_editor)):
    vals = {"medical_class": str(med.medical_class or ""), "medical_exam_date": med.medical_exam_date or "",
            "medical_under_40": "1" if med.medical_under_40 else "0"}
    with db() as conn:
        before = get_medical(conn)
        conn.executemany("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                         list(vals.items()))
        _audit(conn, email, "medical", None, before or None, vals)
        return get_medical(conn)


@app.get("/api/export.csv")
def export_csv(request: Request):
    with db() as conn:
        rows = conn.execute("SELECT * FROM flights ORDER BY date, id").fetchall()
    buf = io.StringIO()
    w = csv.writer(buf)
    cols = ["id"] + [c for c in ALL_FIELDS if is_editor(request) or c not in PUBLIC_HIDDEN]
    w.writerow(cols)
    for r in rows:
        w.writerow([r[c] for c in cols])
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="flightlog-{date.today()}.csv"'})


@app.get("/healthz")
def healthz():
    return JSONResponse({"ok": True})


@app.get("/")
def index():
    return FileResponse(BASE / "static" / "index.html", headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")
