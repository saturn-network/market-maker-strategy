type action = 'NewOrder' | 'CancelOrder' | 'Trade'
type buysell = 'buy' | 'sell'

export interface Trade {
  type: action
  blockchain: string
  contract: string
  order_tx: string
  amount: string
}

export interface CreateOrder {
  type: action
  blockchain: string
  order_type: buysell
  amount: string
  price: string
}

export interface CancelOrder {
  type: action
  blockchain: string
  contract: string
  order_tx: string
}

export type ActionType = Trade | CreateOrder | CancelOrder
