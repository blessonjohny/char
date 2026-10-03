(function () {
  'use strict';

  var categories = [
    'Produce', 'Dairy and eggs', 'Bakery', 'Meat and seafood',
    'Pantry', 'Frozen', 'Beverages', 'Household'
  ];

  // [id, name, unit, tint]
  var shelves = [
    { anchor: 'deals', title: 'Weekly deals', items: [
      ['apples', 'Gala apples', '3 lb bag', '#fde2e2'],
      ['milk', 'Whole milk', '1 gallon', '#e0ecf8'],
      ['sourdough', 'Sourdough loaf', 'Bakery fresh', '#fbe9cf'],
      ['eggs', 'Large eggs', '1 dozen', '#f6efd9'],
      ['spinach', 'Baby spinach', '10 oz', '#dcefdc'],
      ['coffee', 'Ground coffee', '12 oz bag', '#eadbcf']
    ] },
    { anchor: 'produce', title: 'Fresh produce', items: [
      ['bananas', 'Bananas', 'Per lb', '#fbf0b8'],
      ['avocados', 'Avocados', 'Each', '#d9ebcf'],
      ['tomatoes', 'Roma tomatoes', 'Per lb', '#fbd9d0'],
      ['cucumbers', 'Cucumbers', 'Each', '#d3ecdc'],
      ['onions', 'Red onions', 'Per lb', '#ecd7ea'],
      ['lemons', 'Lemons', 'Each', '#fcf3b0']
    ] },
    { anchor: 'dairy', title: 'Dairy and pantry', items: [
      ['butter', 'Salted butter', '1 lb', '#fbf1c9'],
      ['yogurt', 'Greek yogurt', '32 oz tub', '#e6edf7'],
      ['cheddar', 'Sharp cheddar', '8 oz block', '#fbe3b8'],
      ['pasta', 'Spaghetti', '16 oz box', '#f5e6c6'],
      ['rice', 'Basmati rice', '2 lb bag', '#eee9e0'],
      ['oil', 'Olive oil', '500 ml', '#dfe9c8']
    ] }
  ];

  var cart = {};

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function setQty(id, q) {
    cart[id] = Math.max(0, q);
    render();
  }

  function renderCategories() {
    var box = document.getElementById('categories');
    box.textContent = '';
    categories.forEach(function (name) {
      var a = el('a', 'chip', name);
      a.href = '#deals';
      box.appendChild(a);
    });
  }

  function renderShelves() {
    var root = document.getElementById('shelves');
    root.textContent = '';
    shelves.forEach(function (shelf) {
      var sec = el('section', 'shelf');
      sec.id = shelf.anchor;

      var head = el('div', 'shelf-head');
      head.appendChild(el('h2', null, shelf.title));
      var all = el('a', null, 'See all');
      all.href = '#top';
      head.appendChild(all);
      sec.appendChild(head);

      var grid = el('div', 'grid');
      shelf.items.forEach(function (it) {
        var id = it[0], qty = cart[id] || 0;
        var card = el('article', 'card');
        var photo = el('div', 'card-photo', 'Product photo');
        photo.style.background = it[3];
        card.appendChild(photo);
        card.appendChild(el('div', 'card-name', it[1]));
        card.appendChild(el('div', 'card-unit', it[2]));

        var foot = el('div', 'card-foot');
        foot.appendChild(el('span', 'price', '[Price]'));

        if (qty > 0) {
          var st = el('div', 'stepper');
          var minus = el('button', null, '\u2212');
          minus.type = 'button';
          minus.setAttribute('aria-label', 'Remove one ' + it[1]);
          minus.addEventListener('click', function () { setQty(id, qty - 1); });
          var num = el('span', null, String(qty));
          var plus = el('button', null, '+');
          plus.type = 'button';
          plus.setAttribute('aria-label', 'Add one more ' + it[1]);
          plus.addEventListener('click', function () { setQty(id, qty + 1); });
          st.appendChild(minus); st.appendChild(num); st.appendChild(plus);
          foot.appendChild(st);
        } else {
          var add = el('button', 'add-btn', 'Add');
          add.type = 'button';
          add.setAttribute('aria-label', 'Add ' + it[1]);
          add.addEventListener('click', function () { setQty(id, 1); });
          foot.appendChild(add);
        }
        card.appendChild(foot);
        grid.appendChild(card);
      });
      sec.appendChild(grid);
      root.appendChild(sec);
    });
  }

  function render() {
    var total = 0;
    Object.keys(cart).forEach(function (k) { total += cart[k]; });
    document.getElementById('cart-count').textContent = String(total);
    renderShelves();
  }

  renderCategories();
  render();
})();
