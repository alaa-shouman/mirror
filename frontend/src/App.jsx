import { Routes, Route } from 'react-router-dom'
import { useState, useEffect, useCallback } from 'react'
import Navbar from './components/Navbar'
import Landing from './pages/Landing'
import ProductDetail from './pages/ProductDetail'
import Cart from './components/Cart'

function App() {
  const [cartItems, setCartItems] = useState([])
  const [cartOpen, setCartOpen] = useState(false)

  // Hydrate cart from backend on mount
  useEffect(() => {
    fetch('/api/cart')
      .then((res) => res.ok ? res.json() : Promise.reject(res.status))
      .then((items) => {
        // Backend returns [{id, product: {id,name,price,image}, size, quantity}]
        setCartItems(items.map((item) => ({
          cartItemId: item.id,
          product: item.product,
          size: item.size,
          quantity: item.quantity,
        })))
      })
      .catch(() => {
        // Backend unreachable — start with empty local cart
      })
  }, [])

  const addToCart = useCallback((product, size) => {
    // Optimistic local update
    setCartItems((prev) => {
      const existing = prev.find(
        (item) => item.product.id === product.id && item.size === size
      )
      if (existing) {
        return prev.map((item) =>
          item.product.id === product.id && item.size === size
            ? { ...item, quantity: item.quantity + 1 }
            : item
        )
      }
      return [...prev, { cartItemId: null, product, size, quantity: 1 }]
    })
    setCartOpen(true)

    // Persist to backend
    fetch('/api/cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: product.id, size, quantity: 1 }),
    })
      .then((res) => res.ok ? res.json() : Promise.reject(res.status))
      .catch(() => {
        // Backend may be unreachable — local state already updated, cart continues to work
      })
  }, [])

  const removeFromCart = useCallback((productId, size) => {
    const target = cartItems.find(
      (item) => item.product.id === productId && item.size === size
    )

    // Optimistic local removal
    setCartItems((prev) =>
      prev.filter(
        (item) => !(item.product.id === productId && item.size === size)
      )
    )

    // Persist to backend if we have the cart item id
    if (target?.cartItemId) {
      fetch(`/api/cart/${target.cartItemId}`, { method: 'DELETE' }).catch(() => {})
    }
  }, [cartItems])

  return (
    <div className="app">
      <Navbar
        cartCount={cartItems.reduce((sum, item) => sum + item.quantity, 0)}
        onCartClick={() => setCartOpen(!cartOpen)}
      />
      <main className="main-content">
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route
            path="/product/:id"
            element={<ProductDetail addToCart={addToCart} />}
          />
        </Routes>
      </main>
      <Cart
        items={cartItems}
        open={cartOpen}
        onClose={() => setCartOpen(false)}
        onRemove={removeFromCart}
      />
    </div>
  )
}

export default App
