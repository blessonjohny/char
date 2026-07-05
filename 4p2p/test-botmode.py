import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        host = await browser.new_page(viewport={'width': 390, 'height': 844})
        host.on('pageerror', lambda e: print('[PAGE ERROR]', e))
        await host.goto('http://localhost:9000/')
        await host.wait_for_timeout(1000)
        await host.evaluate("document.getElementById('btnGuestPlay').click()")
        await host.wait_for_timeout(300)
        await host.evaluate("document.getElementById('btnPlayOnline').click()")
        await host.wait_for_timeout(300)
        await host.fill('#playerNameInput', 'hhb')
        await host.evaluate("document.getElementById('btnSetName').click()")
        await host.wait_for_timeout(500)
        await host.evaluate("document.getElementById('btnCreateRoom').click()")
        await host.wait_for_timeout(800)
        await host.select_option('#botFillSelect', '3')
        await host.wait_for_timeout(300)
        await host.evaluate("document.getElementById('btnStartGame').click()")
        await host.wait_for_timeout(1000)

        # Turn Bot Mode ON right away, before bidding even starts
        await host.evaluate("botModeActive = true;")
        print("Bot Mode enabled. Driving through bidding/trump/phase2 via direct emits (fast)...")

        for i in range(60):
            state = await host.evaluate("latestServerState")
            if state['phase'] == 'play':
                break
            my_pos = await host.evaluate("MY_POS")
            if state['phase'] in ('bidding1',) and state['currentPlayer'] == my_pos:
                is_first = state['highestBid'] == 0 and state['passes'] == 0
                await host.evaluate(f"gameSocket.emit('placeBid', {{bid: {14 if is_first else 0}}})")
            elif state['phase'] == 'choosingTrump' and state['bidder'] == my_pos:
                await host.evaluate("gameSocket.emit('chooseTrump', {suit: '♠', hiddenCard: null})")
            elif state['phase'] == 'bidding2' and state['currentPlayer'] == my_pos:
                await host.evaluate("gameSocket.emit('passPhase2')")
            await host.wait_for_timeout(200)

        state = await host.evaluate("latestServerState")
        print("Entered play phase. bidder:", state['bidder'], "| my pos:", await host.evaluate("MY_POS"))

        # Now DON'T click anything — just wait and see if Bot Mode auto-plays
        # our cards for us whenever it's our turn.
        my_pos = await host.evaluate("MY_POS")
        my_hand_before = len((await host.evaluate("latestServerState"))['seats'][my_pos].get('hand') or [])
        print(f"My hand size at start of play: {my_hand_before}")

        for i in range(20):
            await host.wait_for_timeout(1000)
            state = await host.evaluate("latestServerState")
            if state['phase'] != 'play':
                print("Round ended (phase now:", state['phase'], ") without any manual card taps.")
                break
            my_hand_now = len((state['seats'][my_pos].get('hand') or []))
            print(f"  [t={i+1}s] phase={state['phase']} currentPlayer={state['currentPlayer']} myHandSize={my_hand_now}")

        final_state = await host.evaluate("latestServerState")
        my_hand_final = len((final_state['seats'][my_pos].get('hand') or []))
        if final_state['phase'] != 'play' or my_hand_final < my_hand_before:
            print(f"\n✅ Bot Mode successfully auto-played cards with zero manual taps (hand went from {my_hand_before} to {my_hand_final})")
        else:
            print(f"\n❌ Bot Mode did NOT auto-play — hand still at {my_hand_final}, phase still {final_state['phase']}")

        await browser.close()

asyncio.run(main())
