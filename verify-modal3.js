import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  // Login first
  await page.goto('http://localhost:7777/login');
  await page.waitForTimeout(2000);

  // Check what the login page looks like
  const loginInfo = await page.evaluate(() => {
    const pwdInputs = document.querySelectorAll('input[type="password"]');
    const userInputs = document.querySelectorAll('input[data-field="username"]');
    const selectUser = document.querySelectorAll('select[data-field="username"]');
    return {
      pwdInputs: pwdInputs.length,
      userInputs: userInputs.length,
      selectUser: selectUser.length,
      options: selectUser.length > 0 ? Array.from(selectUser[0].options).map(o => o.value) : [],
    };
  });
  console.log('Login form info:', loginInfo);

  // If there's a username select, fill it with the first option
  if (loginInfo.selectUser > 0) {
    await page.selectOption('select[data-field="username"]', loginInfo.options[0]);
    // Type password '1'
    await page.fill('input[data-field="password"]', '1');

    // Click "进入" button
    const enterBtn = await page.$('button:has-text("进入")');
    if (enterBtn) {
      await enterBtn.evaluate(el => el.click());
      await page.waitForTimeout(3000);
      console.log('URL after login:', page.url());
    }
  } else if (loginInfo.userInputs > 0) {
    await page.fill('input[data-field="username"]', 'admin');
    await page.fill('input[data-field="password"]', '1');
    const enterBtn = await page.$('button:has-text("进入")');
    if (enterBtn) {
      await enterBtn.evaluate(el => el.click());
      await page.waitForTimeout(3000);
      console.log('URL after login:', page.url());
    }
  }

  // If still on login page, inject console.log monitoring into the page
  // and then interact manually
  if (page.url().includes('/login')) {
    console.log('Still on login page - cannot proceed with browser test');
    console.log('Will instead verify via code inspection');
    await browser.close();
    return;
  }

  await page.screenshot({ path: 'C:/Users/jsbyf/AppData/Local/Temp/vb1.png' });
  console.log('Successfully logged in, URL:', page.url());

  // Navigate to a debit account
  await page.goto('http://localhost:7777/?accountId=cmq62pfa001zsz8uuxzgyvy79&view=detail');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'C:/Users/jsbyf/AppData/Local/Temp/vb2-account.png' });

  // Add console monitoring for React state changes
  await page.evaluate(() => {
    window.__debugLog = [];
    const origCreateElement = document.createElement.bind(document);
    // Monitor DOM mutations for NestedAddModal
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof HTMLElement) {
            if (node.textContent?.includes('新增分类') || node.textContent?.includes('新增机构')) {
              window.__debugLog.push({
                type: 'NESTED_MODAL_ADDED',
                tag: node.tagName,
                class: node.className?.substring(0, 80),
                zIndex: window.getComputedStyle(node).zIndex,
                time: Date.now(),
              });
            }
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });

  // Click 记账 button
  const recordBtn = await page.$('button:has-text("记账")');
  if (!recordBtn) {
    console.log('No 记账 button');
    await browser.close();
    return;
  }

  await recordBtn.evaluate(el => el.click());
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'C:/Users/jsbyf/AppData/Local/Temp/vb3-modal.png' });

  // Find and click category dropdown
  const categoryTrigger = await page.evaluateHandle(() => {
    // Find "类别" label in the form
    const form = document.querySelector('form');
    if (!form) return null;
    const allDivs = Array.from(form.querySelectorAll('div'));
    const labelDiv = allDivs.find(d => d.textContent?.trim() === '类别' && d.classList.contains('text-xs'));
    if (!labelDiv) return null;
    // Get the parent container, then find the dropdown button
    const parent = labelDiv.parentElement;
    return parent?.querySelector('button') || null;
  });

  const catBtn = categoryTrigger.asElement();
  if (catBtn) {
    console.log('Found category trigger, clicking it');
    await catBtn.evaluate(el => el.click());
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'C:/Users/jsbyf/AppData/Local/Temp/vb4-dropdown.png' });

    // Find 新增 button in the dropdown portal
    const addBtns = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button')).filter(b => b.textContent?.includes('新增'))
        .map(b => ({
          text: b.textContent?.trim().substring(0, 30),
          parentClass: b.parentElement?.className?.substring(0, 60),
          zIndex: b.closest('.fixed') ? window.getComputedStyle(b.closest('.fixed')).zIndex : 'none',
        }));
    });
    console.log('Add buttons found:', addBtns);

    // Click the first 新增 button
    const addBtn = await page.$('button:has-text("新增")');
    if (addBtn) {
      await addBtn.evaluate(el => el.click());
      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'C:/Users/jsbyf/AppData/Local/Temp/vb5-nested.png' });

      // Check debug log for NestedAddModal
      const debugLog = await page.evaluate(() => window.__debugLog);
      console.log('Debug log:', debugLog);

      // Final check: look for 新增分类 text
      const hasAddCategory = await page.evaluate(() => document.body.textContent?.includes('新增分类'));
      console.log('Has 新增分类:', hasAddCategory);

      // Check all fixed elements
      const fixedEls = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.fixed.inset-0')).map(el => ({
          zIndex: window.getComputedStyle(el).zIndex,
          text: el.textContent?.trim().substring(0, 50),
          bg: window.getComputedStyle(el).backgroundColor,
          position: window.getComputedStyle(el).position,
        }));
      });
      console.log('All fixed.inset-0 elements:', fixedEls);
    }
  }

  await browser.close();
})();
