import os
import tempfile

# Isolate tests from your real data + Keychain before anything imports uniplan.config
_tmp = tempfile.mkdtemp(prefix="uniplan-test-")
os.environ["UNIPLAN_DATA_DIR"] = _tmp
os.environ["UNIPLAN_NO_KEYCHAIN"] = "1"
os.environ["WEB_PASSWORD"] = "test-pw"
os.environ["CALDAV_PASSWORD"] = "test-caldav"
os.environ["NTFY_TOPIC"] = ""
os.environ["GEMINI_API_KEY"] = ""

import pytest  # noqa: E402
from sqlmodel import SQLModel  # noqa: E402

from uniplan import db  # noqa: E402


@pytest.fixture()
def s():
    db.init_db()
    with db.session() as sess:
        yield sess
    SQLModel.metadata.drop_all(db.engine())
    with db.engine().begin() as c:
        c.exec_driver_sql("DROP TABLE IF EXISTS item_fts")
