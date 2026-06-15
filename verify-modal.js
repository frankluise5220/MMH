import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  // Navigate to overview
  await page.goto('http://localhost:7777/overview');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'C:/Users/jsbyf/AppData/Local/Temp/v1-overview.png' });

  // Check if we're on a login page
  const currentUrl = page.url();
  console.log('Current URL:', currentUrl);

  // Look for password input field
  const passwordInput = await page.$('input[type="password"]');
  if (passwordInput) {
    console.log('Found password input - need to login');
    // Look for any login form
    const loginBtns = await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      return Array.from(btns).map(b => b.textContent?.trim() || '');
    });
    console.log('Login buttons:', loginBtns);

    // Try entering password '1' (common test password)
    await passwordInput.fill('1');
    const submitBtn = await page.$('button[type="submit"]') || await page.$('button');
    if (submitBtn) {
      await submitBtn.click();
      await page.waitForTimeout(3000);
      console.log('After login URL:', page.url());
      await page.screenshot({ path: 'C:/Users/jsbyf/AppData/Local/Temp/v2-after-login.png' });
    }
  } else {
    console.log('No password input - already logged in or different page');
  }

  // Now try to find a debit account and navigate to it
  const accountLinks = await page.evaluate(() => {
    const links = document.querySelectorAll('a');
    return Array.from(links).map(a => ({ href: a.getAttribute('href') || '', text: a.textContent?.trim() || '' }))
      .filter(l => l.href.includes('accountId'));
  });
  console.log('Account links after login:', accountLinks.slice(0, 10));

  // Find a debit account (not credit card, not investment)
  // 招商银行·2758 looks like a debit account
  const debitLink = accountLinks.find(l => l.text.includes('借记卡') || (l.text.includes('银行') && !l.text.includes('基金') && !l.text.includes('信用卡')));
  const targetLink = debitLink || accountLinks.find(l => !l.text.includes('基金')) || accountLinks[0];

  if (targetLink) {
    const url = new URL(targetLink.href, 'http://localhost:7777');
    // Ensure we go to detail view
    url.searchParams.set('view', 'detail');
    console.log('Navigating to:', url.toString());

    await page.goto(url.toString());
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'C:/Users/jsbyf/AppData/Local/Temp/v3-account-page.png' });

    // Find and click 记账 button
    const recordBtn = await page.$('button:has-text("记账")');
    if (!recordBtn) {
      // Try the Plus icon button
      const allBtns = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button')).map(b => ({
          text: b.textContent?.trim().substring(0, 30),
          class: b.className.substring(0, 80),
        }));
      });
      console.log('All buttons:', allBtns.filter(b => b.text));

      // Look for button with Plus icon
      const plusBtn = await page.$('button svg.lucide-plus');
      if (plusBtn) {
        const parentBtn = await plusBtn.evaluateHandle(el => el.closest('button'));
        await parentBtn.asElement()?.click();
      }
    } else {
      console.log('Found 记账 button');
      await recordBtn.click();
    }

    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'C:/Users/jsbyf/AppData/Local/Temp/v4-modal-open.png' });

    // Check if the transaction modal opened
    const modalExists = await page.evaluate(() => {
      const modals = document.querySelectorAll('.fixed.inset-0');
      return Array.from(modals).map(m => ({
        zIndex: window.getComputedStyle(m).zIndex,
        text: m.textContent?.trim().substring(0, 50),
        rect: m.getBoundingClientRect(),
      }));
    });
    console.log('Fixed modals:', modalExists);

    // Find the category CreatableSelect
    // Look for buttons that look like dropdown triggers (with ChevronDown)
    const dropdownBtns = await page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      return Array.from(btns).filter(b => {
        return b.querySelector('.lucide-chevron-down') || b.querySelector('[class*="chevron"]');
      }).map(b => ({
        text: b.textContent?.trim().substring(0, 30),
        class: b.className.substring(0, 80),
        rect: b.getBoundingClientRect(),
      }));
    });
    console.log('Dropdown buttons:', dropdownBtns);

    // Click on the category dropdown (second dropdown, after account)
    // The layout is: row1: date|account, row2: category|tags
    // So we need the category dropdown
    if (dropdownBtns.length >= 2) {
      // Click the category dropdown (likely the 2nd or 3rd dropdown trigger)
      const categoryDropdownIndex = dropdownBtns.findIndex(d => d.text.includes('未分类') || d.text.includes('类别'));
      const targetIndex = categoryDropdownIndex >= 0 ? categoryDropdownIndex : 1; // fallback to second dropdown

      console.log('Clicking dropdown at index:', targetIndex);

      // Get all dropdown trigger buttons and click the right one
      const allDropdownBtns = await page.$$('button');
      let clicked = false;
      for (const btn of allDropdownBtns) {
        const hasChevron = await btn.$('svg.lucide-chevron-down, svg.lucide-ChevronDown');
        if (hasChevron) {
          const text = await btn.textContent();
          if (text?.includes('未分类') || (!clicked && targetIndex === 1)) {
            console.log('Clicking category dropdown, text:', text?.trim());
            await btn.click();
            clicked = true;
            break;
          }
        }
      }

      await page.waitForTimeout(500);
      await page.screenshot({ path: 'C:/Users/jsbyf/AppData/Local/Temp/v5-category-dropdown.png' });

      // Now look for the "+新增" button in the dropdown portal
      const addNewBtn = await page.$('button:has-text("新增")');
      if (addNewBtn) {
        console.log('Found 新增 button in dropdown');
        await addNewBtn.click();
        await page.waitForTimeout(1000);
        await page.screenshot({ path: 'C:/Users/jsbyf/AppData/Local/Temp/v6-after-new-click.png' });

        // Check what's on screen now
        const allFixed = await page.evaluate(() => {
          const els = document.querySelectorAll('.fixed');
          return Array.from(els).map(el => ({
            inset: el.classList.contains('inset-0'),
            zIndex: window.getComputedStyle(el).zIndex,
            text: el.textContent?.trim().substring(0, 80),
            rect: el.getBoundingClientRect(),
            bg: window.getComputedStyle(el).backgroundColor,
          }));
        });
        console.log('All fixed elements after 新增 click:', allFixed);

        // Check specifically for NestedAddModal
        const nestedModal = await page.evaluate(() => {
          // NestedAddModal uses z-[60] and has bg-black/35
          const allZ60 = document.querySelectorAll('[class*="z-[60]"]');
          return Array.from(allZ60).map(el => ({
            text: el.textContent?.trim().substring(0, 100),
            visible: el.offsetHeight > 0 && el.offsetWidth > 0,
            rect: el.getBoundingClientRect(),
          }));
        });
        console.log('NestedAddModal (z-[60]) elements:', nestedModal);

        // Check for "新增分类" text (the title of the category NestedAddModal)
        const categoryModalText = await page.evaluate(() => {
          return document.body.textContent?.includes('新增分类') || document.body.textContent?.includes('新增机构');
        });
        console.log('Category modal text present:', categoryModalText);

      } else {
        console.log('No 新增 button found');
        // Show all portal content
        const portalContent = await page.evaluate(() => {
          const allElements = document.querySelectorAll('body > div');
          return Array.from(allElements).slice(-5).map(el => ({
            class: el.className.substring(0, 80),
            text: el.textContent?.trim().substring(0, 100),
          }));
        });
        console.log('Body divs:', portalContent);
      }
    }
  }

  await browser.close();
})();
