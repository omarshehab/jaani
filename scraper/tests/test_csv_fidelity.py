"""Test 20: CSV fidelity (R6/R7/R8)."""
import os
import random

import pytest

from jaani_scraper import csvio


def test_untouched_rewrite_is_byte_identical(s3_csv, tmp_path):
    rows = csvio.read_csv(s3_csv)
    assert len(rows) == 245
    out = tmp_path / 'out.csv'
    csvio.write_csv_atomic(out, rows)
    assert out.read_bytes() == s3_csv.read_bytes()


def test_sorting_is_by_key_in_code_point_order(s3_csv):
    rows = csvio.read_csv(s3_csv)
    shuffled = rows[:]
    random.Random(7).shuffle(shuffled)
    assert csvio.serialize(shuffled) == s3_csv.read_bytes()


def test_format_crlf_no_bom_trailing_newline(s3_csv):
    data = csvio.serialize(csvio.read_csv(s3_csv))
    assert not data.startswith(b'\xef\xbb\xbf')
    assert data.endswith(b'\r\n')
    assert b'\n' not in data.replace(b'\r\n', b'')


def test_never_overwrite_non_empty_with_empty():
    row = {c: '' for c in csvio.HEADER}
    row.update(Primary_Officer_Name='মো: তোফায়েল হোসেন (১৬২৯৪)', Last_Updated='2026-09-25')
    changes = csvio.merge_row(row, {'Primary_Officer_Name': '', 'Primary_Email': '  '}, '2026-09-29')
    assert changes == []
    assert row['Primary_Officer_Name'] == 'মো: তোফায়েল হোসেন (১৬২৯৪)'
    assert row['Last_Updated'] == '2026-09-25'


def test_changed_value_written_and_old_value_returned_for_log():
    row = {c: '' for c in csvio.HEADER}
    row.update(Primary_Officer_Name='মোঃ শিমুল আকতার', Last_Updated='2026-09-25')
    changes = csvio.merge_row(row, {'Primary_Officer_Name': 'মো: তোফায়েল হোসেন (১৬২৯৪)'}, '2026-09-29')
    assert changes == [('Primary_Officer_Name', 'মোঃ শিমুল আকতার', 'মো: তোফায়েল হোসেন (১৬২৯৪)')]
    assert row['Last_Updated'] == '2026-09-29'


def test_key_columns_are_not_writable():
    row = {c: '' for c in csvio.HEADER}
    with pytest.raises(KeyError):
        csvio.merge_row(row, {'Office': 'x'}, '2026-09-29')


def test_unique_website_link_enforced(s3_csv, tmp_path):
    rows = csvio.read_csv(s3_csv)
    rows[1]['Website_Link'] = rows[0]['Website_Link'] + '/'
    with pytest.raises(ValueError, match='shared by two rows'):
        csvio.write_csv_atomic(tmp_path / 'x.csv', rows)


def test_crash_mid_write_leaves_valid_csv_and_backup(s3_csv, tmp_path, monkeypatch):
    out = tmp_path / 'out.csv'
    rows = csvio.read_csv(s3_csv)
    csvio.write_csv_atomic(out, rows)
    before = out.read_bytes()
    rows[0]['Primary_Officer_Name'] = 'x'

    def boom(*a, **k):
        raise RuntimeError('simulated crash')
    monkeypatch.setattr(os, 'replace', boom)
    with pytest.raises(RuntimeError):
        csvio.write_csv_atomic(out, rows)
    assert out.read_bytes() == before
    assert len(csvio.read_csv(out)) == 245
    assert list((tmp_path / 'backups').iterdir())
    assert not [p for p in tmp_path.iterdir() if p.name.endswith('.tmp')]
