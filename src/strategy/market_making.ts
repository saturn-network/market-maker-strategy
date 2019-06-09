import { Saturn } from '@saturnnetwork/saturn.js'
import { Provider } from 'ethers/providers'
import { Contract } from 'ethers/contract'
import { BigNumber } from 'bignumber.js'
import _ from 'lodash'

import { OrderBookPrinter } from '../charts/orderbook'
import { ActionType, CancelOrder } from '../actiontypes'

import ERC20 from './erc20'

const EtherAddress = '0x0000000000000000000000000000000000000000'
const PRICEDECIMALS = 6

export interface MarketMakerConfig {
  saturn: Saturn,
  provider: Provider,
  blockchain: string,
  token: string,
  fundMinimum: BigNumber,
  tokenLimit: BigNumber,
  spread: BigNumber,
  dustCutoff: BigNumber,
  bandSize: BigNumber,
}

export class MarketMaker {
  saturn: Saturn
  blockchain: string
  token: string
  config: MarketMakerConfig
  botAddress: string

  constructor(
    config: MarketMakerConfig,
    owner: string
  ) {
    this.saturn = config.saturn
    this.blockchain = config.blockchain.toUpperCase()
    this.token = config.token.toLowerCase()
    this.config = config
    this.botAddress = owner
  }

  public async getActions() : Promise<Array<ActionType>> {
    await this.ensureValidOrderBook()
    await this.printMarketHealth()
    let arbs : Array<ActionType> = await this.checkArbOpportunity()
    if (arbs.length) { return arbs }
    let cleanup : Array<ActionType> = await this.cleanupOrders()
    if (cleanup.length) { return cleanup }
    let newOrders : Array<ActionType> = await this.newOrders()
    if (newOrders.length) { return newOrders }

    console.log(`Market Maker is watching 👀. No actions required at this time.`)
    return []
  }

  private async newOrders() {
    let spread = await this.spread()
    if (spread.lte(this.config.spread)) { return [] }
    let buys = await this.newBuys()
    let sells = await this.newSells()
    return buys.concat(sells)
  }

  private async newBuys() : Promise<Array<ActionType>> {
    let alreadyInMarket = await this.etherLockedForAddress(this.botAddress)
    let funds = (await this.availableEther())
    if (funds.isLessThanOrEqualTo(this.config.dustCutoff)) {
      if (alreadyInMarket.isEqualTo(0)) {
        console.log(`
          Not enough ${this.blockchain} in the wallet in order to create buy orders.
          Please send more ether to ${this.botAddress}
        `)
      }
      return []
    }

    let bbp = await this.bestBuyPrice()
    let optimalPrice = (await this.weightedMidMarketPrice())
      .minus((await this.spread()).dividedBy(new BigNumber(2)))

    if (optimalPrice.lte(bbp)) { return [] }
    let tokenAmount = funds.dividedBy(optimalPrice)
    let decimals = await this.tokenDecimals()

    return [{
      type: 'NewOrder',
      blockchain: this.blockchain,
      order_type: 'buy',
      amount: tokenAmount.toFixed(decimals),
      price: optimalPrice.toFixed(PRICEDECIMALS)
    }]
  }

  private async newSells() : Promise<Array<ActionType>> {
    let alreadyInMarket = await this.tokensLockedForAddress(this.botAddress)
    let funds = (await this.availableTokens()).minus(alreadyInMarket)

    if (funds.isLessThanOrEqualTo(new BigNumber(0))) {
      if (alreadyInMarket.isEqualTo(0)) {
        console.log(`
          Not enough tokens (${this.token}:${this.blockchain}) in
          the wallet in order to create sell orders.
          Please send more tokens to ${this.botAddress}
        `)
      }
      return []
    }

    let bsp = await this.bestSellPrice()
    let optimalPrice = (await this.weightedMidMarketPrice())
      .plus((await this.spread()).dividedBy(new BigNumber(2)))

    if (optimalPrice.gte(bsp)) { return [] }

    let decimals = await this.tokenDecimals()

    return [{
      type: 'NewOrder',
      blockchain: this.blockchain,
      order_type: 'sell',
      amount: funds.toFixed(decimals),
      price: optimalPrice.toFixed(PRICEDECIMALS)
    }]
  }

  private async cleanupOrders() : Promise<Array<ActionType>> {
    let myorders = await this.fetchOrdersFor(this.botAddress)
    let tocancel = []
      .concat(await this.pruneSells(myorders.sells))
      .concat(await this.pruneBuys(myorders.buys))
    return _.map(tocancel, x => {
      return {
        type: 'CancelOrder',
        blockchain: this.blockchain,
        contract: x.contract,
        order_tx: x.order_tx
      } as CancelOrder
    })
  }

  private async pruneSells(orders: any) : Promise<Array<any>> {
    let dust = _.chain(orders)
      .filter(x => { return new BigNumber(x.balance).times(new BigNumber(x.price)).lte(this.config.dustCutoff) })
      .map(x => { return { 'contract': x.contract, 'order_tx': x.transaction } })
      .value()

    let cutoff = (await this.weightedMidMarketPrice())
      .plus(this.config.bandSize.times(this.config.spread))

    let outsiders = _.chain(orders)
      .filter(x => { return new BigNumber(x.price).gt(cutoff) })
      .map(x => { return { 'contract': x.contract, 'order_tx': x.transaction, 'price': x.price } })
      .value()

    if (outsiders.length) {
      console.log(`Will attempt to cancel ${this.pluralizedOrders(outsiders)} with price above desired cutoff at ${cutoff} ${this.blockchain}`)
    }

    if (dust.length) {
      console.log(`Will attempt to cancel ${this.pluralizedOrders(dust)} with order balance below dust cutoff of ${this.config.dustCutoff}`)
    }

    return dust.concat(outsiders)
  }

  private async pruneBuys(orders: any) : Promise<Array<any>> {
    let dust = _.chain(orders)
      .filter(x => { return new BigNumber(x.balance).times(new BigNumber(x.price)).lte(this.config.dustCutoff) })
      .map(x => { return { 'contract': x.contract, 'order_tx': x.transaction } })
      .value()

    let cutoff = (await this.weightedMidMarketPrice())
      .minus(this.config.bandSize.times(this.config.spread))

    let outsiders = _.chain(orders)
      .filter(x => { return new BigNumber(x.price).lt(cutoff) })
      .map(x => { return { 'contract': x.contract, 'order_tx': x.transaction, 'price': x.price } })
      .value()

    if (outsiders.length) {
      console.log(`Will attempt to cancel ${this.pluralizedOrders(outsiders)} with price below desired cutoff at ${cutoff} ${this.blockchain}`)
    }

    if (dust.length) {
      console.log(`Will attempt to cancel ${this.pluralizedOrders(dust)} with order balance below dust cutoff of ${this.config.dustCutoff}`)
    }

    return dust.concat(outsiders)
  }

  private pluralizedOrders(orders: Array<any>) : string {
    return orders.length === 1 ? `${orders.length} order` : `${orders.length} orders`
  }

  private async checkArbOpportunity() : Promise<Array<ActionType>> {
    let result : Array<ActionType> = []
    let spread = await this.spread()

    if (spread.lte(new BigNumber(0))) {
      console.log(`Arbitrage opportunity detected!`)
      let bbo : any = await this.bestBuyOrder()
      let bso : any = await this.bestSellOrder()
      let available = await this.availableTokens()

      if (available.isEqualTo(new BigNumber(0))) {
        let tokenAmount = BigNumber.min(
          new BigNumber(bbo.balance),
          new BigNumber(bso.balance)
        )
        let potentialProfit = tokenAmount.times(spread).times(new BigNumber(-1))
        console.log(`
          Detected opportunity to buy ${tokenAmount} tokens for ${bso.price}
          and sell for ${bbo.price} to earn ${potentialProfit} ${this.blockchain},
          but unable to execute due to low funds. Please send more tokens
          to ${this.botAddress}
        `)
        return []
      }

      let tokenAmount = BigNumber.min(
        new BigNumber(bbo.balance),
        new BigNumber(bso.balance),
        available
      )
      let potentialProfit = tokenAmount.times(spread).times(new BigNumber(-1))
      console.log(`
        Will attempt to sell ${tokenAmount} tokens for ${bbo.price}
        and buy for ${bso.price} to earn ${potentialProfit} ${this.blockchain}
      `)

      result.push({
        type: 'Trade',
        blockchain: this.blockchain,
        contract: bbo.contract,
        order_tx: bbo.transaction,
        amount: tokenAmount.toFixed()
      })
      result.push({
        type: 'Trade',
        blockchain: this.blockchain,
        contract: bso.contract,
        order_tx: bso.transaction,
        amount: tokenAmount.toFixed()
      })
    }

    return result
  }

  private async ensureValidOrderBook() {
    let healthyCutoff = 2
    let ob: any = await this.orderBook()
    if (ob.buys.length < healthyCutoff || ob.sells.length < healthyCutoff) {
      throw new Error(`
        The order book for token ${this.blockchain}::${this.token} is too thin
        for this bot to properly work. Consider manually creating orders first.
        The bot needs at least ${healthyCutoff} buy and sell orders.
      `)
    }
  }

  private async printMarketHealth() {
    let spread = await this.spread()
    let wmm = await this.weightedMidMarketPrice()

    let sd = await this.sellDepth()
    let bd = await this.buyDepth()
    let bsp = await this.bestSellPrice()
    let bbp = await this.bestBuyPrice()

    console.log(`Best buy price: ${bbp}`)
    console.log(`Best sell price: ${bsp}`)
    console.log(`Spread: ${spread}`)
    console.log(`Weighted Mid Market Price: ${wmm}`)
    console.log(`Buy Depth: ${sd}`)
    console.log(`Sell Depth: ${bd}`)

    await this.plotOrderBook()
  }

  private async plotOrderBook() {
    let ob : any = await this.orderBook()
    let printer = new OrderBookPrinter(ob)
    printer.print()
  }

  private async orderBook() {
    return await this.saturn.query.orderbook(this.token, this.blockchain)
  }

  private async fetchOrdersFor(address: string) {
    let allOrders = await this.saturn.query.ordersForAddress(address)
    let buys = _.filter(allOrders, (x) => {
      return x.buytoken.address === this.token && x.selltoken.address === EtherAddress
    })
    let sells = _.filter(allOrders, (x) => {
      return x.selltoken.address === this.token && x.buytoken.address === EtherAddress
    })
    return { buys: buys, sells: sells }
  }

  private async weightedMidMarketPrice() : Promise<BigNumber> {
    let bestSellPrice = await this.bestSellPrice()
    let bestBuyPrice = await this.bestBuyPrice()

    let sellDepth = await this.sellDepth()
    let buyDepth = await this.buyDepth()

    return bestSellPrice.times(buyDepth)
      .plus(bestBuyPrice.times(sellDepth))
      .dividedBy(sellDepth.plus(buyDepth))
  }

  private async bestSellOrder() {
    let tokenInfo : any = await this.saturn.query.getTokenInfo(this.token, this.blockchain)
    return await this.saturn.query.getOrderByTx(tokenInfo.best_sell_order_tx, this.blockchain)
  }

  private async bestBuyOrder() {
    let tokenInfo : any = await this.saturn.query.getTokenInfo(this.token, this.blockchain)
    return await this.saturn.query.getOrderByTx(tokenInfo.best_buy_order_tx, this.blockchain)
  }

  private async bestSellPrice() : Promise<BigNumber> {
    let bestOrder : any = await this.bestSellOrder()
    return new BigNumber(bestOrder.price)
  }

  private async bestBuyPrice() : Promise<BigNumber> {
    let bestOrder : any = await this.bestBuyOrder()
    return new BigNumber(bestOrder.price)
  }

  private async spread() : Promise<BigNumber> {
    let bsp = await this.bestSellPrice()
    let bbp = await this.bestBuyPrice()
    return bsp.minus(bbp)
  }

  private async sellDepth() : Promise<BigNumber> {
    let ob : any = await this.orderBook()
    return _.reduce(_.map(ob.sells, (order) => {
      return new BigNumber(order.balance).times(new BigNumber(order.price))
    }), (x, y) => x.plus(y), new BigNumber(0))
  }

  private async buyDepth() : Promise<BigNumber> {
    let ob : any = await this.orderBook()
    return _.reduce(_.map(ob.buys, (order) => {
      return new BigNumber(order.balance).times(new BigNumber(order.price))
    }), (x, y) => x.plus(y), new BigNumber(0))
  }

  private async availableEther() : Promise<BigNumber> {
    let myBalance = (await this.config.provider.getBalance(this.botAddress)).toString()
    let weiMinimum = this.pow(10, 18).times(this.config.fundMinimum)
    let ether = new BigNumber(myBalance).minus(weiMinimum).dividedBy(this.pow(10, 18))
    return BigNumber.max(0, ether)
  }

  private async availableTokens() : Promise<BigNumber> {
    let contract = new Contract(this.token, ERC20, this.config.provider)
    let tokenbalance = (await contract.balanceOf(this.botAddress)).valueOf()
    let decimals = await this.tokenDecimals()
    return BigNumber.min(
      new BigNumber(tokenbalance).dividedBy(this.pow(10, decimals)),
      this.config.tokenLimit
    )
  }

  private async etherLockedForAddress(address: string) : Promise<BigNumber> {
    let orders : any = (await this.fetchOrdersFor(address)).buys
    return _.reduce(_.map(orders, (order) => {
      return new BigNumber(order.balance).times(new BigNumber(order.price))
    }), (x, y) => x.plus(y), new BigNumber(0))
  }

  private async tokensLockedForAddress(address: string) : Promise<BigNumber> {
    let orders : any = (await this.fetchOrdersFor(address)).sells
    return _.reduce(_.map(orders, (order) => {
      return new BigNumber(order.balance)
    }), (x, y) => x.plus(y), new BigNumber(0))
  }

  private async tokenDecimals() : Promise<number> {
    let contract = new Contract(this.token, ERC20, this.config.provider)
    let decimals = (await contract.decimals()).valueOf()
    return Number(decimals)
  }

  private pow(n: BigNumber | number | string, p: number) : BigNumber {
    let multiplier = n instanceof BigNumber ? n : new BigNumber(n)
    let out = new BigNumber(1)
    for (let i = 0; i < p; ++i) { out = out.times(multiplier) }
    return out
  }
}
