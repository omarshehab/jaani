/* Section 3 compatibility (brief 15.2, 15.3, 15.8): a role without its own photo shows none, never a photo from the
 * page's position-based image list; legacy-font rejections show a short Bengali notice. */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import VerificationGrid from '../VerificationGrid';
import { AppProvider } from '../../context/AppContext';

const wrap = (ui) => render(<AppProvider>{ui}</AppProvider>);

const P = 'https://objectstorage.ap-dcc-gazipur-1.oraclecloud15.com/n/a/b/V2Ministry/o/office-t/p.jpg';
const AP = 'https://objectstorage.ap-dcc-gazipur-1.oraclecloud15.com/n/a/b/V2Ministry/o/office-t/ap.jpg';
const BANNER = 'https://t.gov.bd/uploads/banner.jpg';

const record = {
  Office: 'পরীক্ষা অধিদপ্তর',
  office_name: 'পরীক্ষা অধিদপ্তর',
  Website_Link: 'https://t.gov.bd/views/info-officers',
  Primary_Officer: 'মো: তোফায়েল হোসেন (১৬২৯৪)',
  Primary_Photo: P,
  Alternate_Officer: 'নাসরীন সুলতানা (১৬২১৮)',
  Alternate_Photo: '',
  Appellate_Officer: 'মনজুর মোর্শেদ চৌধুরী',
  Appellate_Photo: AP,
};

beforeEach(() => {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      success: true,
      imageUrl: P,
      images: [P, AP, BANNER],
      primaryImage: P,
      alternateImage: AP,
      appellateImage: BANNER,
    }),
  }));
});

afterEach(() => {
  delete global.fetch;
});

const srcs = (container) => Array.from(container.querySelectorAll('img')).map((i) => i.getAttribute('src') || '');

test('a role with a name but no photo shows no photo, never a positional one', async () => {
  const { container } = wrap(
    <VerificationGrid databaseContact={record} scrapedContact={record} isLoading={false} />,
  );
  await waitFor(() => expect(srcs(container).some((s) => s.includes('p.jpg'))).toBe(true));
  await new Promise((r) => setTimeout(r, 50));
  const all = srcs(container);
  expect(all.filter((s) => s.includes('ap.jpg'))).toHaveLength(1);
  expect(all.some((s) => s.includes('banner.jpg'))).toBe(false);
});

test('legacy-font rejections are shown as a short Bengali notice', async () => {
  wrap(
    <VerificationGrid
      databaseContact={record}
      scrapedContact={record}
      isLoading={false}
      integrityWarnings={[{ field: 'Alternate_Designation', class: 'BIJOY_ANSI' }]}
    />,
  );
  expect(await screen.findByText(/পুরনো ফন্টে/)).toBeTruthy();
});
