import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        host_ctx = await browser.new_context(viewport={'width': 390, 'height': 844})
        host = await host_ctx.new_page()
        host.on('pageerror', lambda e: print('[HOST PAGE ERROR]', e))
        await host.goto('http://localhost:9000/')
        await host.wait_for_timeout(1000)
        await host.evaluate("document.getElementById('btnGuestPlay').click()")
        await host.wait_for_timeout(300)
        await host.evaluate("document.getElementById('btnPlayOnline').click()")
        await host.wait_for_timeout(300)
        await host.fill('#playerNameInput', 'tyy')
        await host.evaluate("document.getElementById('btnSetName').click()")
        await host.wait_for_timeout(500)
        await host.evaluate("document.getElementById('btnCreateRoom').click()")
        await host.wait_for_timeout(800)
        await host.select_option('#botFillSelect', '3')
        await host.wait_for_timeout(300)
        await host.evaluate("document.getElementById('btnStartGame').click()")
        await host.wait_for_timeout(1000)

        # Drive bidding1 by clicking real buttons whenever it's our turn
        for i in range(30):
            state = await host.evaluate("latestServerState")
            if state['phase'] != 'bidding1':
                break
            my_pos = await host.evaluate("MY_POS")
            if state['currentPlayer'] == my_pos:
                await host.wait_for_timeout(500)
                is_first = await host.evaluate("document.querySelector('.bid-btn.pass-btn') === null")
                if is_first:
                    btn = await host.query_selector('.bid-btn')
                    if btn:
                        await btn.click()
                    else:
                        print(f"!!! no bid button found (iter {i}, highestBid={state['highestBid']}, bidder={state['bidder']}, myPos={my_pos}) !!!")
                        break
                else:
                    passbtn = await host.query_selector('.bid-btn.pass-btn')
                    if passbtn: await passbtn.click()
                    else: print("!!! no pass button found !!!")
                await host.wait_for_timeout(400)
            else:
                await host.wait_for_timeout(300)

        state = await host.evaluate("latestServerState")
        print("After bidding1 (clicking real buttons):", state['phase'], "bidder:", state['bidder'], "bid:", state['highestBid'])

        # If we're the bidder, choose trump by clicking a real suit button
        for i in range(10):
            state = await host.evaluate("latestServerState")
            if state['phase'] != 'choosingTrump':
                break
            my_pos = await host.evaluate("MY_POS")
            if state['bidder'] == my_pos:
                await host.wait_for_timeout(500)
                suits = await host.query_selector_all('.trump-btn:not([disabled])')
                print("Available (non-disabled) trump suit buttons found:", len(suits))
                if suits:
                    await suits[0].click()
                    await host.wait_for_timeout(300)
                    confirm = await host.query_selector('#trumpConfirm')
                    if confirm:
                        is_disabled = await confirm.get_attribute('disabled')
                        print("trumpConfirm disabled after picking suit:", is_disabled)
                        await confirm.click()
                    await host.wait_for_timeout(300)
            await host.wait_for_timeout(300)

        state = await host.evaluate("latestServerState")
        print("After trump selection:", state['phase'])

        # Drive phase 2 by clicking REAL raise/pass buttons
        for i in range(20):
            state = await host.evaluate("latestServerState")
            if state['phase'] != 'bidding2':
                break
            my_pos = await host.evaluate("MY_POS")
            if state['currentPlayer'] == my_pos:
                await host.wait_for_timeout(500)
                btns = await host.query_selector_all('.bid-btn')
                texts = [await b.text_content() for b in btns]
                print("Phase2 buttons visible:", texts)
                pass_btn = None
                for b, t in zip(btns, texts):
                    if 'PASS' in (t or ''):
                        pass_btn = b
                if pass_btn:
                    await pass_btn.click()
                    await host.wait_for_timeout(400)
                else:
                    print("!!! NO PASS BUTTON FOUND during phase2 on my turn — this is the bug !!!")
                    html = await host.evaluate("document.getElementById('bidOverlay').outerHTML")
                    print(html[:2000])
                    break
            else:
                await host.wait_for_timeout(300)

        state = await host.evaluate("latestServerState")
        print("\nFINAL phase:", state['phase'], "| bidder:", state['bidder'], "| bid:", state['highestBid'])
        if state['phase'] == 'play':
            print("✅ Successfully reached play phase via real UI clicks")
        else:
            print("❌ STUCK in", state['phase'])
            print("Current player:", state['currentPlayer'], "| my pos:", await host.evaluate("MY_POS"))
            overlay_visible = await host.evaluate("document.getElementById('bidOverlay').classList.contains('on')")
            print("bidOverlay showing:", overlay_visible)

        await browser.close()

asyncio.run(main())
