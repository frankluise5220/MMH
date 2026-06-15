import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  // First navigate to login page and authenticate
  await page.goto('http://localhost:7777/login');
  await page.waitForTimeout(2000);

  // Find and fill password field
  const pwdField = await page.$('input[type="password"]');
  if (pwdField) {
    // Try password '1' - common dev test password
    await pwdField.fill('1');
    await page.waitForTimeout(500);

    // Find "进入" button and click it
    const enterBtn = await page.$('button:has-text("进入")');
    if (enterBtn) {
      // Force click to bypass overlays
      await enterBtn.evaluate(el => el.click());
      await page.waitForTimeout(3000);
      console.log('After login URL:', page.url());
    } else {
      console.log('No 进入 button found');
      // Check for overlay blocking
      const overlay = await page.$('.fixed.inset-0');
      if (overlay) {
        // Remove overlay to unblock
        await overlay.evaluate(el => el.remove());
        await page.waitForTimeout(1000);
        const enterBtnRetry = await page.$('button:has-text("进入")');
        if (enterBtnRetry) {
          await enterBtnRetry.evaluate(el => el.click());
          await page.waitForTimeout(3000);
        }
      }
    }
  }

  await page.screenshot({ path: 'C:/Users/jsbyf/AppData/Local/Temp/va1-after-login.png' });

  // Navigate to overview to find accounts
  await page.goto('http://localhost:7777/overview');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'C:/Users/jsbyf/AppData/Local/Temp/va2-overview.png' });

  // Get account links
  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a')).filter(a => a.href.includes('accountId'))
      .map(a => ({ href: a.getAttribute('href') || '', text: a.textContent?.trim() || '' }));
  });
  console.log('Account links:', links.slice(0, 5));

  // Navigate to first account (debit card)
  if (links.length > 0) {
    const target = links.find(l => !l.text.includes('基金')) || links[0];
    const url = new URL(target.href, 'http://localhost:7777');
    url.searchParams.set('view', 'detail');
    await page.goto(url.toString());
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'C:/Users/jsbyf/AppData/Local/Temp/va3-account.png' });

    // Click 记账 button
    const recordBtns = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button')).filter(b => b.textContent?.includes('记账'))
        .map(b => ({ text: b.textContent?.trim() || '', class: b.className.substring(0, 50) }));
    });
    console.log('Record buttons:', recordBtns);

    // Find and click 记账 button using force click to bypass potential overlays
    const recordBtn = await page.$('button:has-text("记账")');
    if (recordBtn) {
      await recordBtn.evaluate(el => el.click());
      await page.waitForTimeout(1500);
      await page.screenshot({ path: 'C:/Users/jsbyf/AppData/Local/Temp/va4-modal.png' });
      console.log('Clicked 记账 button');

      // Now examine the DOM structure
      const domInfo = await page.evaluate(() => {
        // Get all direct children of body
        const bodyChildren = Array.from(document.body.children);
        return bodyChildren.map(el => ({
          tag: el.tagName,
          class: el.className?.substring(0, 80),
          zIndex: el instanceof HTMLElement ? window.getComputedStyle(el).zIndex : 'N/A',
          fixed: el instanceof HTMLElement ? window.getComputedStyle(el).position : 'N/A',
          text: el.textContent?.trim().substring(0, 50),
        }));
      });
      console.log('Body direct children:', domInfo.filter(d => d.fixed === 'fixed'));

      // Find the category dropdown trigger buttons (buttons with chevron-down inside the modal)
      const dropdownTriggers = await page.evaluate(() => {
        const modalEl = document.querySelector('.fixed.inset-0.z-50');
        if (!modalEl) return 'No modal found';
        const btns = modalEl.querySelectorAll('button');
        return Array.from(btns).map(b => ({
          text: b.textContent?.trim().substring(0, 30),
          hasChevron: !!b.querySelector('svg'),
          svgClass: b.querySelector('svg')?.getAttribute('class')?.substring(0, 30),
        }));
      });
      console.log('Modal button details:', dropdownTriggers);

      // Click the category dropdown trigger
      // Category is in the second row (类别), which should be a CreatableSelect
      // Find all CreatableSelect trigger buttons (they have ChevronDown icon)
      // In the modal, there should be: date input, account dropdown, category dropdown, tag selector, amount, attachment, note

      // Strategy: find all buttons with chevron-down inside the modal form, click the one for category
      const categoryBtnHandle = await page.evaluateHandle(() => {
        const modalEl = document.querySelector('.fixed.inset-0.z-50');
        if (!modalEl) return null;
        const form = modalEl.querySelector('form');
        if (!form) return null;

        // Find all label-like divs with "类别" text
        const labels = Array.from(form.querySelectorAll('div'));
        const categoryLabel = labels.find(l => l.textContent?.trim() === '类别');

        if (!categoryLabel) return null;

        // Navigate to parent container, then find the dropdown trigger button
        const container = categoryLabel.parentElement;
        if (!container) return null;

        // Find the CreatableSelect trigger button (has ChevronDown icon)
        const btn = container.querySelector('button');
        return btn;
      });

      if (categoryBtnHandle) {
        const btnEl = categoryBtnHandle.asElement();
        if (btnEl) {
          console.log('Found category dropdown trigger');
          await btnEl.evaluate(el => el.click());
          await page.waitForTimeout(500);
          await page.screenshot({ path: 'C:/Users/jsbyf/AppData/Local/Temp/va5-category-dropdown.png' });

          // Check if dropdown portal appeared
          const portalInfo = await page.evaluate(() => {
            const portals = Array.from(document.querySelectorAll('.fixed.inset-0')).filter(el => {
              const style = window.getComputedStyle(el);
              return style.zIndex === '9999' || el.classList.contains('z-\\[9999\\]');
            });
            return portals.map(p => ({
              zIndex: window.getComputedStyle(p).zIndex,
              text: p.textContent?.trim().substring(0, 100),
            }));
          });
          console.log('Dropdown portals:', portalInfo);

          // Click 新增 button in the dropdown
          const addNewBtn = await page.$('button:has-text("新增")');
          if (addNewBtn) {
            console.log('Found 新增 button');
            await addNewBtn.evaluate(el => el.click());
            await page.waitForTimeout(1000);
            await page.screenshot({ path: 'C:/Users/jsbyf/AppData/Local/Temp/va6-nested-modal.png' });

            // Check if NestedAddModal appeared
            const modalCheck = await page.evaluate(() => {
              const allFixed = Array.from(document.querySelectorAll('.fixed.inset-0'));
              return allFixed.map(el => ({
                zIndex: window.getComputedStyle(el).zIndex,
                text: el.textContent?.trim().substring(0, 80),
                visible: el.offsetHeight > 0,
                bgColor: window.getComputedStyle(el).backgroundColor,
              }));
            });
            console.log('All fixed modals after 新增 click:', modalCheck);

            // Check specifically for "新增分类" text
            const hasAddModal = await page.evaluate(() => {
              return document.body.textContent?.includes('新增分类');
            });
            console.log('Has 新增分类 text:', hasAddModal);
          } else {
            console.log('No 新增 button found in dropdown');
          }
        }
      } else {
        console.log('Could not find category dropdown trigger');
      }
    } else {
      console.log('No 记账 button found');
    }
  }

  await browser.close();
})();
