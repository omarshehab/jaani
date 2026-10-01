"""Section 15.7(d): run the two reference articles through Sections 2 -> 3 on a sandboxed backend and keep a summary
(persons, RTI target/cards, guidance routing, Section 3 matches) for before/after comparison.
  scraper/.venv/bin/python -m compat.section2_probe --csv <csv> --out <file.json> [--port 5107]"""
import argparse
import json
import time
from pathlib import Path

import httpx

from . import sandbox

ARTICLES = ['https://www.prothomalo.com/bangladesh/crime/diag0jvbhb',
            'https://www.prothomalo.com/business/economics/dsqg6uqgyj']


def office_query(analysis):
    """Same order as Home.deriveOfficeQueryFromAnalysis."""
    ro = analysis.get('related_offices')
    if isinstance(ro, list) and ro:
        return ' | '.join(str(x) for x in ro if x)
    for k in ('rti_target_office', 'related_office', 'related_ministry'):
        if analysis.get(k):
            return analysis[k]
    return ''


def probe(base, url):
    c = httpx.Client(base_url=base, timeout=180)
    out = {'url': url}
    art = c.post('/api/analyze', json={'url': url}).json()
    text = art.get('text') or ''
    out['article_chars'] = len(text)
    an = c.post('/api/analyze-text', json={'text': text, 'llm_provider': 'auto', 'url': url}).json()
    a = an.get('data') or an
    ent = c.post('/api/extract-entities', json={'text': text, 'llm_provider': 'auto'}).json()
    en = ent.get('enriched') or {}
    out['persons'] = sorted({e.get('text', '') for e in a.get('entities') or [] if e.get('label') == 'PER'})
    out['news_persons'] = [f"{p.get('name', '')} | {p.get('designation', '')}" for p in en.get('news_persons') or []]
    out['rti_target_office'] = a.get('rti_target_office', '')
    out['mentioned_gov_orgs'] = a.get('mentioned_gov_orgs') or []
    out['rti_cards'] = [{'entity': e.get('originalEntity', ''), 'office': (e.get('databaseMatch') or {}).get('office', ''),
                         'match': (e.get('databaseMatch') or {}).get('matchType', ''),
                         'primary': ((e.get('databaseMatch') or {}).get('officers') or {}).get('primary', {}).get('name', '')
                         if isinstance((e.get('databaseMatch') or {}).get('officers'), dict) else ''}
                        for e in a.get('enriched_entities') or []]
    out['extract_entities_card'] = {'office': en.get('office', ''), 'matched_body': en.get('matched_body'),
                                    'primary': ((en.get('officers') or {}).get('primary') or {}).get('name', ''),
                                    'appellate': ((en.get('officers') or {}).get('appellate') or {}).get('name', '')}
    g = c.post('/api/rti-guidance', json={'text': text, 'title': art.get('title', ''), 'llm_provider': 'auto'}).json()
    guidance = g.get('guidance') or {}
    out['guidance_keys'] = sorted(guidance.keys())
    out['guidance_text'] = json.dumps(guidance, ensure_ascii=False)[:4000]
    q = office_query(a)
    out['office_query'] = q
    if q:
        ml = {k: a.get(k) for k in ('rti_target_office', 'related_ministry', 'related_ministries', 'entities',
                                    'verified_entities')}
        v = c.post('/api/verify-contact', json={'office_name': q, 'enrich_web': False, 'mlAnalysis': ml}).json()
        out['verify_matches'] = [m.get('Office') or m.get('office_name') for m in v.get('matches', [])]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--port', type=int, default=5107)
    ap.add_argument('--root', default='/private/tmp/jaani_sandbox_s2')
    a = ap.parse_args()
    root = sandbox.build(a.root, a.csv, seed_photos=True)
    proc = sandbox.start(root, port=a.port, reader_port=a.port - 3, extra_env={'WEBSITE_LINK_MAX_WAIT_MS': '4000'})
    try:
        res = [probe(f'http://127.0.0.1:{a.port}', u) for u in ARTICLES]
    finally:
        sandbox.stop(proc)
    Path(a.out).write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding='utf-8')
    for r in res:
        print(r['url'], '| target:', r['rti_target_office'], '| cards:', [c['office'] for c in r['rti_cards']],
              '| verify:', r.get('verify_matches'))


if __name__ == '__main__':
    main()
