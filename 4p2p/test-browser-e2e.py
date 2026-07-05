import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()

        # --- Host tab ---
        host_ctx = await browser.new_context(viewport={'width': 390, 'height': 844})
        host = await host_ctx.new_page()
        host.on('console', lambda m: print('[HOST console]', m.text) if 'error' in m.text.lower() else None)
        host.on('pageerror', lambda e: print('[HOST PAGE ERROR]', e, '\n', getattr(e, 'stack', 'no stack')))
        await host.goto('http://localhost:9000/')
        await host.wait_for_timeout(1000)

        # Guest play, name, online
        await host.evaluate("document.getElementById('btnGuestPlay').click()")
        await host.wait_for_timeout(300)
        await host.evaluate("document.getElementById('btnPlayOnline').click()")
        await host.wait_for_timeout(300)
        await host.fill('#playerNameInput', 'HostAlice')
        await host.evaluate("document.getElementById('btnSetName').click()")
        await host.wait_for_timeout(500)
        await host.evaluate("document.getElementById('btnCreateRoom').click()")
        await host.wait_for_timeout(800)

        table_id = await host.evaluate("MY_TABLE_ID")
        print("Table created:", table_id)
        assert table_id, "Host never got a table id — createTable flow broken"

        # --- Guest tab ---
        guest_ctx = await browser.new_context(viewport={'width': 390, 'height': 844})
        guest = await guest_ctx.new_page()
        guest.on('pageerror', lambda e: print('[GUEST PAGE ERROR]', e))
        await guest.goto('http://localhost:9000/')
        await guest.wait_for_timeout(1000)
        await guest.evaluate("document.getElementById('btnGuestPlay').click()")
        await guest.wait_for_timeout(300)
        await guest.evaluate("document.getElementById('btnPlayOnline').click()")
        await guest.wait_for_timeout(300)
        await guest.fill('#playerNameInput', 'GuestBob')
        await guest.evaluate("document.getElementById('btnSetName').click()")
        await guest.wait_for_timeout(500)
        await guest.fill('#joinRoomId', table_id)
        await guest.evaluate("document.getElementById('btnJoinRoom').click()")
        await guest.wait_for_timeout(800)

        guest_pos = await guest.evaluate("MY_POS")
        guest_token = await guest.evaluate("MY_PLAYER_TOKEN")
        print("Guest joined at pos", guest_pos, "token", guest_token)
        assert guest_pos is not None and guest_pos >= 0, "Guest never got seated"

        # --- Host fills bots and starts ---
        await host.select_option('#botFillSelect', '2')
        await host.wait_for_timeout(1000)  # let the lobby safety-net poll catch up before clicking
        await host.evaluate("document.getElementById('btnStartGame').click()")
        await host.wait_for_timeout(1000)

        host_phase = await host.evaluate("latestServerState && latestServerState.phase")
        print("Phase after start:", host_phase)
        assert host_phase == 'bidding1', f"Expected bidding1, got {host_phase}"

        # --- Drive bidding forward: whoever's turn it is (host or guest) passes/bids minimum, bots auto-act ---
        for i in range(30):
            state = await host.evaluate("latestServerState")
            if state['phase'] != 'bidding1':
                break
            cp = state['currentPlayer']
            host_pos = await host.evaluate("MY_POS")
            if cp == host_pos:
                await host.evaluate("serverPlaceBid(0)")
            elif cp == guest_pos:
                await guest.evaluate("serverPlaceBid(0)")
            await host.wait_for_timeout(250)

        state = await host.evaluate("latestServerState")
        print("Bidding resolved. Phase:", state['phase'], "bidder:", state['bidder'], "bid:", state['highestBid'])
        assert state['phase'] in ('choosingTrump', 'bidding2', 'play'), f"Bidding never resolved, stuck in {state['phase']}"

        # If the bidder is a human (host or guest), pick a trump for them
        for i in range(10):
            state = await host.evaluate("latestServerState")
            if state['phase'] != 'choosingTrump':
                break
            bidder_pos = state['bidder']
            host_pos = await host.evaluate("MY_POS")
            if bidder_pos == host_pos:
                await host.evaluate("serverChooseTrump('♠', null)")
            elif bidder_pos == guest_pos:
                await guest.evaluate("serverChooseTrump('♠', null)")
            await host.wait_for_timeout(400)

        state = await host.evaluate("latestServerState")
        print("Phase after trump:", state['phase'])
        assert state['phase'] in ('bidding2', 'play'), f"Expected bidding2 or play, stuck in {state['phase']}"

        # --- Drive phase 2 (raise round): everyone passes ---
        for i in range(20):
            state = await host.evaluate("latestServerState")
            if state['phase'] != 'bidding2':
                break
            cp = state['currentPlayer']
            host_pos = await host.evaluate("MY_POS")
            if cp == host_pos:
                await host.evaluate("gameSocket.emit('passPhase2')")
            elif cp == guest_pos:
                await guest.evaluate("gameSocket.emit('passPhase2')")
            await host.wait_for_timeout(300)

        state = await host.evaluate("latestServerState")
        print("Phase after phase-2 raise round:", state['phase'], "| final bidder:", state['bidder'], "| final bid:", state['highestBid'])
        assert state['phase'] == 'play', f"Phase 2 never resolved, stuck in {state['phase']}"
        # Note: by the time we read state here, bot seats may have already
        # taken several turns (they act instantly) — the play-order fix
        # itself is verified separately at the engine level (see
        # test-engine.js's stress test), not by racing bot auto-play here.

        guest_hand_before = await guest.evaluate("(latestServerState.seats[%d].hand || []).length" % guest_pos)
        print("Guest hand size entering play:", guest_hand_before)
        assert guest_hand_before == 7 or guest_hand_before == 8, f"Unexpected hand size {guest_hand_before}"

        # --- THE ACTUAL POINT: disconnect the guest mid-game ---
        print("\n>>> Disconnecting guest mid-game (simulating a dropped connection) <<<")
        await guest.evaluate("gameSocket.disconnect()")
        await host.wait_for_timeout(500)

        host_state_after_drop = await host.evaluate("latestServerState")
        guest_seat_after_drop = host_state_after_drop['seats'][guest_pos]
        print("Host's view of guest's seat after drop:", guest_seat_after_drop and {
            'name': guest_seat_after_drop['name'], 'connected': guest_seat_after_drop['connected'],
            'cardCount': guest_seat_after_drop['cardCount']
        })
        assert guest_seat_after_drop is not None, "Seat vanished — this is exactly the old bug"
        assert guest_seat_after_drop['connected'] == False
        assert guest_seat_after_drop['cardCount'] == guest_hand_before, "Hand size changed on disconnect — cards were lost"
        print(">>> Seat, hand, and game all survived the disconnect. <<<")

        # --- Reconnect the SAME guest tab (same page, same localStorage token) ---
        print("\n>>> Guest reconnecting (same browser/token) <<<")
        await guest.evaluate("gameSocket.connect()")
        await guest.wait_for_timeout(1000)

        guest_state_after_reconnect = await guest.evaluate("latestServerState")
        guest_pos_after = await guest.evaluate("MY_POS")
        guest_hand_after = (guest_state_after_reconnect['seats'][guest_pos_after].get('hand') or [])
        print("Reconnected at pos:", guest_pos_after, "| hand size:", len(guest_hand_after))
        assert guest_pos_after == guest_pos, "Reconnected to a DIFFERENT seat than before"
        assert len(guest_hand_after) == guest_hand_before, "Hand not preserved across reconnect"
        print(">>> Reconnected to the exact same seat with the exact same hand. <<<")

        await browser.close()
        print("\n✅ FULL BROWSER END-TO-END TEST PASSED")

asyncio.run(main())
