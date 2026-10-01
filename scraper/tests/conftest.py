import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
sys.path.insert(0, str(ROOT))
FIXTURES = ROOT / 'tests' / 'fixtures'
S3_CSV = REPO / 's3' / 'JAANI_RTI_OFFICERS_COMPLETE.csv'


def pytest_configure(config):
    config.addinivalue_line('markers', 'live: needs the network and JAANI_CONTACT_EMAIL')


@pytest.fixture
def s3_csv():
    return S3_CSV
