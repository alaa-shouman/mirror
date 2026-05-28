import { useState, useEffect } from 'react'
import { demoProducts } from '../data/demoProducts'

const PRODUCTS_TIMEOUT_MS = 8000

export function useProducts() {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [demoMode, setDemoMode] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), PRODUCTS_TIMEOUT_MS)

    fetch('/api/products', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`Products API returned ${res.status}`)
        return res.json()
      })
      .then((data) => {
        setProducts(data.length ? data : demoProducts)
        setDemoMode(data.length === 0)
        setLoading(false)
      })
      .catch(() => {
        setProducts(demoProducts)
        setDemoMode(true)
        setLoading(false)
      })
      .finally(() => {
        clearTimeout(timeoutId)
      })

    return () => {
      clearTimeout(timeoutId)
      controller.abort()
    }
  }, [])

  return { products, loading, demoMode }
}
